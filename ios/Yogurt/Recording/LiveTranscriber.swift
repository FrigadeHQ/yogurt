@preconcurrency import AVFoundation
import os
@preconcurrency import Speech

private let log = Logger(subsystem: "so.yogurt.ios", category: "transcript")

/// What the screen hears from the live transcript. Called on the main actor.
struct TranscriberEvents: Sendable {
    /// text, start and end in ms of audio recorded, and whether it is settled
    var result: @MainActor @Sendable (String, Int, Int, Bool) -> Void = { _, _, _, _ in }
    /// a plain sentence about the transcript, nil once there is nothing to say
    var notice: @MainActor @Sendable (String?) -> Void = { _ in }
}

/// Speech to text on this iPhone, fed the recorder's buffers. Nothing goes to a server.
protocol LiveTranscriber: AnyObject, Sendable {
    /// on the audio thread
    func append(_ buffer: AVAudioPCMBuffer)
    /// the last words settle; returns once they have (or soon after)
    func finish() async
}

/// Holds the recorder's first buffers while the transcriber gets ready, then passes them on, so the start of the
/// meeting is in the transcript too.
final class TranscriberRelay: @unchecked Sendable {
    private let lock = NSLock()
    private var target: LiveTranscriber?
    private var waiting: [AVAudioPCMBuffer] = []
    private var off = false
    /// about a minute and a half of 4096-frame buffers at 48 kHz
    private let keep = 1000

    func append(_ buffer: AVAudioPCMBuffer) {
        let to: LiveTranscriber? = lock.withLock {
            if let target { return target }
            if !off, let copy = buffer.copied() {
                waiting.append(copy)
                if waiting.count > keep { waiting.removeFirst() }
            }
            return nil
        }
        to?.append(buffer)
    }

    func attach(_ t: LiveTranscriber?) {
        let queued: [AVAudioPCMBuffer] = lock.withLock {
            target = t
            off = t == nil
            defer { waiting = [] }
            return waiting
        }
        for b in queued { t?.append(b) }
    }

    var current: LiveTranscriber? { lock.withLock { target } }
}

enum LiveTranscription {
    /// The best transcriber this iPhone has for the language: SpeechAnalyzer, else the older on-device recogniser.
    /// nil when neither can run here; the notice then says why.
    static func start(locale: Locale, events: TranscriberEvents, relay: TranscriberRelay) async {
        if let analyzer = await AnalyzerTranscriber.make(locale: locale, events: events) {
            relay.attach(analyzer)
            do {
                try await analyzer.run()
                return
            } catch {
                log.error("SpeechAnalyzer failed: \(String(describing: error), privacy: .public)")
            }
        }
        if let older = await RecognizerTranscriber.make(locale: locale, events: events) {
            relay.attach(older)
            await events.notice(nil)
            return
        }
        relay.attach(nil)
        let speechOff = SFSpeechRecognizer.authorizationStatus() == .denied || SFSpeechRecognizer.authorizationStatus() == .restricted
        await events.notice(speechOff ? S.transcriptNeedsSpeech : S.transcriptUnavailable)
    }
}

// MARK: - SpeechAnalyzer (iOS 26)

final class AnalyzerTranscriber: LiveTranscriber, @unchecked Sendable {
    private let transcriber: SpeechTranscriber
    private let analyzer: SpeechAnalyzer
    private let format: AVAudioFormat
    private let locale: Locale
    private let events: TranscriberEvents
    private let stream: AsyncStream<AnalyzerInput>
    private let input: AsyncStream<AnalyzerInput>.Continuation
    private let lock = NSLock()
    private var converter: AVAudioConverter?
    private var results: Task<Void, Never>?

    static func make(locale: Locale, events: TranscriberEvents) async -> AnalyzerTranscriber? {
        guard SpeechTranscriber.isAvailable, let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else { return nil }
        let t = SpeechTranscriber(locale: supported, transcriptionOptions: [], reportingOptions: [.volatileResults],
                                  attributeOptions: [.audioTimeRange])
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [t]) else { return nil }
        return AnalyzerTranscriber(transcriber: t, format: format, locale: supported, events: events)
    }

    private init(transcriber: SpeechTranscriber, format: AVAudioFormat, locale: Locale, events: TranscriberEvents) {
        self.transcriber = transcriber
        self.format = format
        self.locale = locale
        self.events = events
        analyzer = SpeechAnalyzer(modules: [transcriber], options: .init(priority: .userInitiated, modelRetention: .whileInUse))
        // the meeting keeps recording while the language downloads, so its audio waits here (about 30 min at most)
        (stream, input) = AsyncStream.makeStream(of: AnalyzerInput.self, bufferingPolicy: .bufferingNewest(20_000))
    }

    /// Gets the language's model onto the iPhone the first time, then listens until finish().
    func run() async throws {
        if await AssetInventory.status(forModules: [transcriber]) != .installed {
            await events.notice(S.transcriptDownloading(languageName(locale)))
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                try await request.downloadAndInstall()
            }
            await events.notice(nil)
        }
        let report = events.result
        results = Task { [transcriber] in
            do {
                for try await r in transcriber.results {
                    let text = String(r.text.characters)
                    await report(text, ms(r.range.start), ms(r.range.end), r.isFinal)
                }
            } catch {
                log.error("transcript results ended: \(String(describing: error), privacy: .public)")
            }
        }
        try await analyzer.start(inputSequence: stream)
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        guard let converted = convert(buffer) else { return }
        input.yield(AnalyzerInput(buffer: converted))
    }

    func finish() async {
        input.finish()
        do { try await analyzer.finalizeAndFinishThroughEndOfInput() } catch {
            log.error("finishing the transcript failed: \(String(describing: error), privacy: .public)")
        }
        await results?.value
    }

    private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if buffer.format == format { return buffer.copied() }
        return lock.withLock {
            if converter?.inputFormat != buffer.format { converter = AVAudioConverter(from: buffer.format, to: format) }
            guard let converter else { return nil }
            return converter.convertOnce(buffer, to: format)
        }
    }
}

// MARK: - SFSpeechRecognizer, on the device only

/// For when SpeechAnalyzer or its language isn't there. One request covers under a minute of audio, then the next
/// takes over, which keeps each result small and its times close.
final class RecognizerTranscriber: LiveTranscriber, @unchecked Sendable {
    private let recognizer: SFSpeechRecognizer
    private let events: TranscriberEvents
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var tasks: [SFSpeechRecognitionTask] = []
    private var requestStartMs = 0
    private var heardMs = 0
    private var open = 0
    private static let requestMs = 55_000

    static func make(locale: Locale, events: TranscriberEvents) async -> RecognizerTranscriber? {
        var status = SFSpeechRecognizer.authorizationStatus()
        if status == .notDetermined {
            status = await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) } }
        }
        guard status == .authorized, let r = SFSpeechRecognizer(locale: locale), r.supportsOnDeviceRecognition else { return nil }
        return RecognizerTranscriber(recognizer: r, events: events)
    }

    private init(recognizer: SFSpeechRecognizer, events: TranscriberEvents) {
        self.recognizer = recognizer; self.events = events
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        guard let copy = buffer.copied() else { return }
        lock.withLock {
            if request == nil || heardMs - requestStartMs >= Self.requestMs { next() }
            request?.append(copy)
            heardMs += Int(Double(buffer.frameLength) / buffer.format.sampleRate * 1000)
        }
    }

    func finish() async {
        let waiting: Bool = lock.withLock {
            request?.endAudio()
            request = nil
            return open > 0
        }
        guard waiting else { return }
        // the last words settle within a second or two; never wait on them for long
        for _ in 0..<40 {
            if lock.withLock({ open == 0 }) { return }
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    /// Under the lock.
    private func next() {
        request?.endAudio()
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.requiresOnDeviceRecognition = true
        req.shouldReportPartialResults = true
        req.addsPunctuation = true
        req.taskHint = .dictation
        let base = heardMs
        requestStartMs = base
        request = req
        open += 1
        let report = events.result
        var ended = false
        let task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            if let result {
                let segs = result.bestTranscription.segments
                let start = base + Int((segs.first?.timestamp ?? 0) * 1000)
                let end = base + Int(((segs.last?.timestamp ?? 0) + (segs.last?.duration ?? 0)) * 1000)
                let text = result.bestTranscription.formattedString
                let final = result.isFinal
                Task { @MainActor in report(text, start, max(start, end), final) }
            }
            guard let self, !ended, error != nil || result?.isFinal == true else { return }
            ended = true
            self.lock.withLock { self.open -= 1 }
        }
        tasks.append(task)
        if tasks.count > 3 { tasks.removeFirst() }
    }
}

// MARK: - Helpers

private func ms(_ t: CMTime) -> Int {
    let s = t.seconds
    return s.isFinite ? max(0, Int((s * 1000).rounded())) : 0
}

/// "English", for the notice and for the notes model.
func languageName(_ locale: Locale) -> String {
    let code = locale.language.languageCode?.identifier ?? "en"
    return Locale(identifier: "en").localizedString(forLanguageCode: code) ?? "English"
}

/// the converter's input block runs on the calling thread, once per call
private final class Fed: @unchecked Sendable { var done = false }

extension AVAudioConverter {
    /// One buffer through, for audio that arrives a buffer at a time (the converter keeps its state between calls).
    func convertOnce(_ buffer: AVAudioPCMBuffer, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        let fed = Fed()
        var error: NSError?
        convert(to: out, error: &error) { _, status in
            if fed.done { status.pointee = .noDataNow; return nil }
            fed.done = true
            status.pointee = .haveData
            return buffer
        }
        return error == nil && out.frameLength > 0 ? out : nil
    }
}

extension AVAudioPCMBuffer {
    /// A copy that outlives the engine's buffer.
    func copied() -> AVAudioPCMBuffer? {
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameLength) else { return nil }
        out.frameLength = frameLength
        let src = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: audioBufferList))
        let dst = UnsafeMutableAudioBufferListPointer(out.mutableAudioBufferList)
        for (s, d) in zip(src, dst) {
            guard let from = s.mData, let to = d.mData else { continue }
            memcpy(to, from, Int(min(s.mDataByteSize, d.mDataByteSize)))
        }
        return out
    }
}
