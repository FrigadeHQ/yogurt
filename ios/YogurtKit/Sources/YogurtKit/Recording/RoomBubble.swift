import Foundation

/// A single-microphone recording has one incoming side, even when several people speak.
public struct RoomBubble: Identifiable, Sendable, Equatable {
    public let id: Int
    public let startMs: Int
    public let showsTime: Bool
    public private(set) var text = ""
    public private(set) var liveText = ""
    private var endMs: Int

    public static func group(_ lines: [LocalRecording.Line]) -> [Self] {
        lines.reduce(into: []) { append($1, to: &$0) }
    }

    public static func append(_ line: LocalRecording.Line, live: Bool = false, to bubbles: inout [Self]) {
        let words = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return }
        let gap = bubbles.last.map { line.startMs - $0.endMs } ?? .max
        if gap >= LiveTranscript.newLineAfterMs {
            bubbles.append(Self(id: bubbles.count, startMs: line.startMs,
                                showsTime: gap >= ShareExport.newTurnAfterMs, endMs: line.endMs))
        }
        let i = bubbles.count - 1
        bubbles[i].endMs = line.endMs
        if live {
            bubbles[i].liveText = words
        } else {
            if !bubbles[i].text.isEmpty { bubbles[i].text += " " }
            bubbles[i].text += words
        }
    }
}

/// A recognizer can correct a word in place or drop a prefix that just became final.
public struct LiveWordArrivals: Sendable {
    public struct Word: Sendable {
        public let text: String
        public let arrived: Date
    }
    public private(set) var words: [Word] = []
    public init() {}

    public mutating func update(_ text: String, at date: Date) {
        guard !text.isEmpty else { words = []; return }
        var starts: [String.Index] = []
        text.enumerateSubstrings(in: text.startIndex..<text.endIndex, options: [.byWords, .substringNotRequired]) { _, range, _, _ in
            starts.append(range.lowerBound)
        }
        if starts.isEmpty { starts = [text.startIndex] } else { starts[0] = text.startIndex }
        let parts = zip(starts, starts.dropFirst() + [text.endIndex]).map { String(text[$0..<$1]) }
        let next = parts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        let old = words.map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }
        var offset = 0, best = 0
        for i in old.indices where old[i] == next.first {
            var n = 1
            while i + n < old.count, n < next.count, old[i + n] == next[n] { n += 1 }
            if n >= best { best = n; offset = i }
        }
        words = parts.enumerated().map { i, part in
            Word(text: part, arrived: i + offset < words.count ? words[i + offset].arrived : date)
        }
    }
}
