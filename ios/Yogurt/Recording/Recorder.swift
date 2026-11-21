@preconcurrency import AVFoundation
import os
import YogurtKit

private let log = Logger(subsystem: "so.yogurt.ios", category: "recorder")

/// The microphone to an m4a file. AVAudioEngine's input tap goes to AAC through AVAssetWriter in movie fragments, so
/// the file is playable up to the last few seconds even if Yogurt is killed mid-meeting. The same buffers go to the
/// live transcript. Background audio keeps it going with the screen locked; a call pauses it and its end resumes it.
final class Recorder: @unchecked Sendable {
    /// what the screen hears about; called on the main actor
    struct Events: Sendable {
        var level: @MainActor @Sendable (Double) -> Void = { _ in }
        /// true when a call or another app took the microphone, false when it gave it back
        var interrupted: @MainActor @Sendable (Bool) -> Void = { _ in }
        /// the recording can't go on as it is (a sentence for the person)
        var failed: @MainActor @Sendable (String) -> Void = { _ in }
    }

    enum RecorderError: Error { case noMicrophone, cantWrite }

    /// each buffer heard, on the audio thread, for the live transcript
    var onBuffer: (@Sendable (AVAudioPCMBuffer) -> Void)?
    var events = Events()

    private var engine = AVAudioEngine()
    private let queue = DispatchQueue(label: "so.yogurt.recorder")
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    /// what the file is written from: mono float at the first input's sample rate
    private var fileFormat: AVAudioFormat?
    private var formatDescription: CMAudioFormatDescription?
    /// on the queue: frames written so far, which is also the file's clock
    private var frames: Int64 = 0
    /// on the queue: a failed write is reported once
    private var reportedFailure = false
    private let lock = NSLock()
    private var running = false
    private var observers: [NSObjectProtocol] = []

    /// The audio written so far, in ms.
    var durationMs: Int {
        queue.sync { fileFormat.map { Int(Double(frames) / $0.sampleRate * 1000) } ?? 0 }
    }

    func start(writingTo url: URL) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.allowBluetoothHFP, .defaultToSpeaker])
        try session.setActive(true)
        guard session.isInputAvailable else { throw RecorderError.noMicrophone }

        let hw = engine.inputNode.outputFormat(forBus: 0)
        guard hw.sampleRate > 0, hw.channelCount > 0 else { throw RecorderError.noMicrophone }
        // AAC takes 8 to 48 kHz; anything else is converted to 48
        let rate = (8000...48000).contains(hw.sampleRate) ? hw.sampleRate : 48000
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false) else {
            throw RecorderError.cantWrite
        }
        try openWriter(url, format: format)
        observe()
        try startEngine()
    }

    func pause() {
        setRunning(false)
        engine.pause()
    }

    func resume() throws {
        try AVAudioSession.sharedInstance().setActive(true)
        try startEngine()
    }

    /// Closes the file. The audio is never thrown away, even when closing fails: the fragments written are kept.
    func stop() async -> Int {
        setRunning(false)
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        for o in observers { NotificationCenter.default.removeObserver(o) }
        observers = []
        let (writer, input) = queue.sync { (self.writer, self.input) }
        if let writer, writer.status == .writing {
            input?.markAsFinished()
            await writer.finishWriting()
            if writer.status != .completed { log.error("finishing the file failed: \(String(describing: writer.error), privacy: .public)") }
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        return durationMs
    }

    // MARK: - Engine

    private func startEngine() throws {
        let node = engine.inputNode
        node.removeTap(onBus: 0)
        let hw = node.outputFormat(forBus: 0)
        guard hw.sampleRate > 0, hw.channelCount > 0 else { throw RecorderError.noMicrophone }
        let converter = queue.sync { fileFormat.flatMap { hw == $0 ? nil : AVAudioConverter(from: hw, to: $0) } }
        let target = queue.sync { fileFormat }
        // about 85 ms at 48 kHz: the meter moves ~12 times a second, like desktop's
        node.installTap(onBus: 0, bufferSize: 4096, format: hw) { [weak self] buffer, _ in
            guard let self, self.isRunning else { return }
            self.onBuffer?(buffer)
            self.meter(buffer)
            guard let target else { return }
            let mono = converter.flatMap { $0.convertOnce(buffer, to: target) } ?? buffer
            self.queue.async { self.write(mono) }
        }
        engine.prepare()
        try engine.start()
        setRunning(true)
    }

    private var isRunning: Bool { lock.withLock { running } }
    private func setRunning(_ on: Bool) { lock.withLock { running = on } }

    private func meter(_ buffer: AVAudioPCMBuffer) {
        guard let data = buffer.floatChannelData else { return }
        let level = micLevel(dbfs: dbfs(rms: UnsafeBufferPointer(start: data[0], count: Int(buffer.frameLength))))
        let report = events.level
        Task { @MainActor in report(level) }
    }

    // MARK: - File

    private func openWriter(_ url: URL, format: AVAudioFormat) throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .m4a)
        // a fragment every few seconds: a crash loses only the last one
        writer.movieFragmentInterval = CMTime(seconds: 4, preferredTimescale: 600)
        let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: format.sampleRate >= 32000 ? 64000 : 32000,
        ])
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { throw RecorderError.cantWrite }
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? RecorderError.cantWrite }
        writer.startSession(atSourceTime: .zero)
        var desc: CMAudioFormatDescription?
        CMAudioFormatDescriptionCreate(allocator: nil, asbd: format.streamDescription, layoutSize: 0, layout: nil, magicCookieSize: 0,
                                       magicCookie: nil, extensions: nil, formatDescriptionOut: &desc)
        queue.sync {
            self.writer = writer; self.input = input; self.fileFormat = format; self.formatDescription = desc; self.frames = 0
        }
    }

    /// On the queue. Time in the file runs on with the audio, so a pause leaves no gap and transcript times match it.
    private func write(_ buffer: AVAudioPCMBuffer) {
        guard let writer, let input, let formatDescription, let fileFormat, writer.status == .writing, buffer.frameLength > 0 else { return }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: CMTimeScale(fileFormat.sampleRate)),
                                        presentationTimeStamp: CMTime(value: frames, timescale: CMTimeScale(fileFormat.sampleRate)),
                                        decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        guard CMSampleBufferCreate(allocator: nil, dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil, refcon: nil,
                                   formatDescription: formatDescription, sampleCount: CMItemCount(buffer.frameLength),
                                   sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 0, sampleSizeArray: nil,
                                   sampleBufferOut: &sample) == noErr, let sample,
              CMSampleBufferSetDataBufferFromAudioBufferList(sample, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0,
                                                             bufferList: buffer.audioBufferList) == noErr else { return }
        // the encoder keeps up in real time; if it ever doesn't, the frames still count so the clock stays true
        if input.isReadyForMoreMediaData, !input.append(sample), !reportedFailure {
            reportedFailure = true
            log.error("writing audio failed: \(String(describing: writer.error), privacy: .public)")
            let failed = events.failed
            Task { @MainActor in failed(S.recordingWriteFailed) }
        }
        frames += Int64(buffer.frameLength)
    }

    // MARK: - Calls, route changes, resets

    private func observe() {
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] note in
                guard let self, let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                      let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
                let report = self.events.interrupted
                if type == .began { self.setRunning(false) }
                Task { @MainActor in report(type == .began) }
            },
            // a headset plugged in or taken out: the input's format can change, so the tap starts again
            center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil) { [weak self] _ in
                guard let self, self.isRunning else { return }
                do { try self.startEngine() } catch {
                    log.error("restarting after a route change failed: \(String(describing: error), privacy: .public)")
                    self.setRunning(false)
                    let report = self.events.interrupted
                    Task { @MainActor in report(true) }
                }
            },
            // the audio system restarted: a new engine, then the same as a call ending
            center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil) { [weak self] _ in
                guard let self else { return }
                self.setRunning(false)
                self.engine = AVAudioEngine()
                try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .spokenAudio, options: [.allowBluetoothHFP, .defaultToSpeaker])
                let report = self.events.interrupted
                Task { @MainActor in report(true); report(false) }
            },
        ]
    }
}
