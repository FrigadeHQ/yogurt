import Foundation

/// Where a recording on the phone is, and how long it has recorded. Every change is an event that is refused when it
/// doesn't fit (a second Stop, a resume that wasn't paused), so the audio side can send events without checking.
public struct RecordingState: Sendable, Equatable {
    public enum PauseReason: Sendable, Equatable {
        case byYou
        /// a phone call or another app took the microphone
        case interrupted
    }

    public enum Phase: Sendable, Equatable {
        case idle
        /// asking for the microphone and starting the audio
        case starting
        case recording
        case paused(PauseReason)
        /// finishing the file and the transcript
        case stopping
        case finished
        /// a sentence the person can act on
        case failed(String)
    }

    public private(set) var phase: Phase = .idle
    private var runningSince: Date?
    private var banked: TimeInterval = 0

    public init() {}

    public var isPaused: Bool { if case .paused = phase { true } else { false } }
    /// recording or paused: the meeting is still going
    public var isLive: Bool { phase == .recording || isPaused }

    /// Seconds recorded: paused time doesn't count.
    public func elapsed(at now: Date) -> TimeInterval {
        banked + (runningSince.map { max(0, now.timeIntervalSince($0)) } ?? 0)
    }

    public mutating func begin() -> Bool {
        switch phase {
        case .idle, .failed: phase = .starting; banked = 0; runningSince = nil; return true
        default: return false
        }
    }

    public mutating func started(at now: Date) -> Bool {
        guard phase == .starting else { return false }
        phase = .recording
        runningSince = now
        return true
    }

    public mutating func pause(_ reason: PauseReason, at now: Date) -> Bool {
        guard phase == .recording else { return false }
        bank(now)
        phase = .paused(reason)
        return true
    }

    public mutating func resume(at now: Date) -> Bool {
        guard isPaused else { return false }
        phase = .recording
        runningSince = now
        return true
    }

    /// Only a pause the call made ends with the call: one the person chose stays.
    public mutating func interruptionEnded(at now: Date) -> Bool {
        guard phase == .paused(.interrupted) else { return false }
        return resume(at: now)
    }

    public mutating func stop(at now: Date) -> Bool {
        guard isLive else { return false }
        bank(now)
        phase = .stopping
        return true
    }

    public mutating func finished() -> Bool {
        guard phase == .stopping else { return false }
        phase = .finished
        return true
    }

    public mutating func fail(_ message: String) {
        runningSince = nil
        phase = .failed(message)
    }

    private mutating func bank(_ now: Date) {
        if let since = runningSince { banked += max(0, now.timeIntervalSince(since)) }
        runningSince = nil
    }
}

/// What the Summary pane says about a phone recording's notes while there are none.
public enum DraftNotice: Sendable, Equatable {
    case writing
    /// paired: the computer writes them once it has the recording
    case computerWillWrite
    /// on its own, on an iPhone without Apple Intelligence
    case needsAppleIntelligence
    /// on its own, and writing them here didn't work
    case notWritten
    /// on its own, and Apple's model is still getting ready on this iPhone
    case modelPreparing
    /// on its own, and Apple's model doesn't write the language it was recorded in
    case languageNotSupported

    public static func `for`(hasSummary: Bool, writing: Bool, modelAvailable: Bool, modelPreparing: Bool = false, languageSupported: Bool = true,
                             paired: Bool) -> DraftNotice? {
        if hasSummary { return nil }
        if writing { return .writing }
        if paired { return .computerWillWrite }
        if modelPreparing { return .modelPreparing }
        if !modelAvailable { return .needsAppleIntelligence }
        return languageSupported ? .notWritten : .languageNotSupported
    }
}

/// A recording still going, kept beside its audio so a crash or a killed app loses neither: at the next launch it
/// becomes a meeting like any other.
public struct RecordingInProgress: Sendable, Codable, Equatable {
    public var id: String
    public var startedAt: Date
    /// the audio's file name, in the same folder
    public var audioFile: String
    public var myNotes: String = ""
    public var lines: [LocalRecording.Line] = []
    /// the spoken language it is transcribed in (BCP-47); nil from an older build
    public var language: String?

    public init(id: String, startedAt: Date, audioFile: String) {
        self.id = id; self.startedAt = startedAt; self.audioFile = audioFile
    }

    /// durationMs: the audio's length when it could be read, else the end of the last line.
    public func recording(in folder: URL, title: String, durationMs: Int?) -> LocalRecording {
        let ms = durationMs ?? lines.map(\.endMs).max() ?? 0
        return LocalRecording(id: id, title: title, startedAt: startedAt, endedAt: startedAt.addingTimeInterval(Double(ms) / 1000),
                              attendees: [], audioURL: folder.appendingPathComponent(audioFile), myNotes: myNotes,
                              transcript: lines, summary: nil, language: language)
    }
}

extension LocalRecording {
    /// The transcript as the Store and the summarizer read it.
    public var segments: [Segment] {
        transcript.enumerated().map { Segment(index: $0.offset, startMs: $0.element.startMs, endMs: $0.element.endMs, speaker: nil, text: $0.element.text) }
    }
}
