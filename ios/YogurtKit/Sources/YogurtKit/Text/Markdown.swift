import Foundation

/// One block of the Markdown the desktop writes summaries and My notes in. Inline marks (bold, links) are left in
/// `text` for the view to render; only the block shapes the desktop editor makes are recognised.
public enum MarkdownBlock: Sendable, Hashable {
    /// level 1–3 (deeper headings read as 3)
    case heading(level: Int, text: String)
    case bullet(level: Int, text: String)
    case numbered(number: Int, level: Int, text: String)
    case task(done: Bool, level: Int, text: String)
    case paragraph(String)
    case rule
}

public func markdownBlocks(_ markdown: String) -> [MarkdownBlock] {
    var blocks: [MarkdownBlock] = []
    var paragraph: [String] = []
    func flush() {
        if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
    }
    for raw in markdown.components(separatedBy: .newlines) {
        let line = raw.trimmingCharacters(in: .whitespaces)
        guard !line.isEmpty else { flush(); continue }
        if let block = block(line, level: indentLevel(raw)) {
            flush(); blocks.append(block)
        } else {
            paragraph.append(line)
        }
    }
    flush()
    return blocks
}

/// Two spaces or one tab per level.
private func indentLevel(_ raw: String) -> Int {
    var spaces = 0
    for c in raw {
        if c == " " { spaces += 1 } else if c == "\t" { spaces += 2 } else { break }
    }
    return spaces / 2
}

private func block(_ line: String, level: Int) -> MarkdownBlock? {
    if line.allSatisfy({ $0 == "-" || $0 == "*" || $0 == "_" }), line.count >= 3, Set(line).count == 1 { return .rule }
    if let hashes = line.firstIndex(where: { $0 != "#" }), hashes > line.startIndex, line[hashes] == " " {
        let n = line.distance(from: line.startIndex, to: hashes)
        if n <= 6 { return .heading(level: min(n, 3), text: trimmed(line[hashes...])) }
    }
    if let first = line.first, "-*+".contains(first), line.dropFirst().first == " " {
        let rest = trimmed(line.dropFirst(2))
        for (mark, done) in [("[ ] ", false), ("[x] ", true), ("[X] ", true)] where rest.hasPrefix(mark) {
            return .task(done: done, level: level, text: trimmed(rest.dropFirst(mark.count)))
        }
        return .bullet(level: level, text: rest)
    }
    let digits = line.prefix(while: \.isNumber)
    if !digits.isEmpty, digits.count <= 9, let number = Int(digits) {
        let rest = line.dropFirst(digits.count)
        if let mark = rest.first, ".)".contains(mark), rest.dropFirst().first == " " {
            return .numbered(number: number, level: level, text: trimmed(rest.dropFirst(2)))
        }
    }
    return nil
}

private func trimmed(_ s: Substring) -> String { s.trimmingCharacters(in: .whitespaces) }
