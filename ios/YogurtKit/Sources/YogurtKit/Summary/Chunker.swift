import Foundation

/// Cuts a transcript into pieces small enough for Apple's on-device model, like desktop's splitForContext: only
/// between lines, and a line too long on its own between sentences, then words. Nothing is dropped or repeated.
public enum Chunker {
    public static func chunks(_ segments: [Segment], maxChars: Int = 6000) -> [String] {
        chunks(lines: segments.compactMap(line), maxChars: maxChars)
    }

    /// The same for text already written as lines (part notes being merged).
    public static func chunks(text: String, maxChars: Int = 6000) -> [String] {
        chunks(lines: text.components(separatedBy: "\n"), maxChars: maxChars, keepBlank: true)
    }

    /// "You: …" for the phone's own speaker, "Leo: …" for a named one; the phone's one-mic lines have no label.
    static func line(_ s: Segment) -> String? {
        let text = s.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        switch s.speaker {
        case nil: return text
        case "me": return "You: \(text)"
        case let name?: return "\(name): \(text)"
        }
    }

    private static func chunks(lines: [String], maxChars: Int, keepBlank: Bool = false) -> [String] {
        let limit = max(1, maxChars)
        let pieces = lines.filter { keepBlank || !$0.isEmpty }.flatMap { $0.count <= limit ? [$0] : cut($0, limit) }
        var out: [String] = []
        var current = ""
        var started = false
        for p in pieces {
            // +1 for the line break
            if started && current.count + 1 + p.count > limit {
                out.append(current)
                current = p
            } else {
                current = started ? current + "\n" + p : p
            }
            started = true
        }
        if started { out.append(current) }
        return keepBlank ? out : out.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    /// One line longer than the limit: whole sentences while they fit, then whole words, then characters.
    static func cut(_ line: String, _ limit: Int) -> [String] {
        var out: [String] = []
        var current = ""
        func flush() { let t = current.trimmingCharacters(in: .whitespaces); if !t.isEmpty { out.append(t) }; current = "" }
        for sentence in sentences(line) {
            if current.count + sentence.count <= limit { current += sentence; continue }
            flush()
            if sentence.count <= limit { current = sentence; continue }
            for word in words(sentence) {
                if current.count + word.count <= limit { current += word; continue }
                flush()
                if word.count <= limit { current = word; continue }
                var rest = Substring(word)
                while rest.count > limit { out.append(String(rest.prefix(limit))); rest = rest.dropFirst(limit) }
                current = String(rest)
            }
        }
        flush()
        return out
    }

    /// Sentences with the spaces after them, so joining them gives the line back.
    private static func sentences(_ s: String) -> [String] {
        var out: [String] = []
        var current = ""
        var ended = false
        for ch in s {
            if ended && !ch.isWhitespace { out.append(current); current = ""; ended = false }
            current.append(ch)
            if ".!?。！？".contains(ch) { ended = true }
        }
        if !current.isEmpty { out.append(current) }
        return out
    }

    private static func words(_ s: String) -> [String] {
        var out: [String] = []
        var current = ""
        for ch in s {
            current.append(ch)
            if ch.isWhitespace { out.append(current); current = "" }
        }
        if !current.isEmpty { out.append(current) }
        return out
    }
}
