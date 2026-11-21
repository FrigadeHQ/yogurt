import Foundation

/// The transcript as it is heard. The recogniser sends text that is still changing (volatile) and then settles it in
/// short phrases; phrases of one sentence are joined into a line, so the transcript reads like desktop's.
public struct LiveTranscript: Sendable, Equatable {
    /// a line is closed at a sentence end past this many characters, so a long run doesn't become one wall of text
    public static let maxLine = 280
    /// a pause this long starts a new line
    static let newLineAfterMs = 2500

    public private(set) var lines: [LocalRecording.Line] = []
    /// what is being heard now; it may still change
    public private(set) var volatile = ""
    private var volatileStart = 0
    private var volatileEnd = 0

    public init() {}

    public mutating func update(_ text: String, startMs: Int, endMs: Int, isFinal: Bool) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        guard isFinal else {
            volatile = t; volatileStart = startMs; volatileEnd = endMs
            return
        }
        volatile = ""
        guard !t.isEmpty else { return }
        // a recogniser started again can report a start before the last end
        let start = max(startMs, lines.last?.endMs ?? 0)
        let end = max(endMs, start)
        if var last = lines.last, joins(last, t, start) {
            last.text += " " + t
            last.endMs = end
            lines[lines.count - 1] = last
        } else {
            lines.append(.init(startMs: start, endMs: end, text: t))
        }
    }

    /// Everything heard, the still-changing words too: what is saved if the recording stops now.
    public var settled: [LocalRecording.Line] {
        guard !volatile.isEmpty else { return lines }
        let start = max(volatileStart, lines.last?.endMs ?? 0)
        return lines + [.init(startMs: start, endMs: max(volatileEnd, start), text: volatile)]
    }

    private func joins(_ last: LocalRecording.Line, _ next: String, _ start: Int) -> Bool {
        guard start - last.endMs < Self.newLineAfterMs else { return false }
        // a finished sentence ends its line
        let ended = last.text.last.map { ".!?。！？".contains($0) } ?? false
        return !ended && last.text.count + 1 + next.count <= Self.maxLine + 60
    }
}
