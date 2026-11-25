import Foundation

public struct SearchHit: Sendable, Identifiable, Hashable {
    public enum Field: String, Sendable, Codable { case title, mine, summary, transcript }
    public var meetingId: String
    public var title: String
    /// where the words were found (the first of title, My notes, summary, transcript that has them)
    public var field: Field
    /// a few words around the match, from that field
    public var snippet: String
    /// the matched words within `snippet`, to show in bold
    public var highlights: [Range<String.Index>]
    public var id: String { meetingId }
}

// Private-use characters mark matches, so nothing a person types can be taken for a marker.
private let open = "\u{E000}", close = "\u{E001}"
private let fields: [SearchHit.Field] = [.title, .mine, .summary, .transcript]

extension Store {
    /// Meetings (not trashed) with every word of `query`, best first. Words are matched as typed, so quotes and
    /// operators like AND or NEAR( are just words; the last one can be unfinished ("ban" finds "banana").
    public func search(_ query: String, limit: Int) -> [SearchHit] {
        guard let match = ftsQuery(query), limit > 0 else { return [] }
        let snippets = (1...4).map { "snippet(search, \($0), '\(open)', '\(close)', '…', 12)" }.joined(separator: ", ")
        // title counts most, then My notes, then the summary, then the transcript
        let rows = (try? db.query("""
            SELECT search.meeting_id, m.title, \(snippets) FROM search JOIN meetings m ON m.id = search.meeting_id
            WHERE search MATCH ? AND m.trashed_at IS NULL ORDER BY bm25(search, 0, 10, 5, 3, 1) LIMIT ?
            """, [.text(match), .of(limit)])) ?? []
        return rows.map { r in
            let marked = (0..<4).map { r[2 + $0].string ?? "" }
            let i = marked.firstIndex { $0.contains(open) } ?? 0
            let (snippet, highlights) = unmark(marked[i])
            return SearchHit(meetingId: r[0].string ?? "", title: r[1].string ?? "", field: fields[i], snippet: snippet, highlights: highlights)
        }
    }

    /// Rebuilds the search row of each meeting from what is stored now.
    func reindex(_ ids: Set<String>) throws {
        for id in ids {
            try db.run("DELETE FROM search WHERE meeting_id = ?", [.text(id)])
            guard let title = try db.query("SELECT title FROM meetings WHERE id = ?", [.text(id)]).first?[0] else { continue }
            let notes = try db.query("SELECT mine, summary FROM notes WHERE meeting_id = ?", [.text(id)]).first
            let transcript = try db.query("SELECT text FROM segments WHERE meeting_id = ? ORDER BY idx", [.text(id)])
                .compactMap { $0[0].string }.joined(separator: "\n")
            try db.run("INSERT INTO search (meeting_id, title, mine, summary, transcript) VALUES (?, ?, ?, ?, ?)",
                       [.text(id), title, notes?[0] ?? .null, notes?[1] ?? .null, .text(transcript)])
        }
    }
}

/// Each word as an FTS5 string ("" escapes a quote), so nothing in it is read as syntax; the last is a prefix.
/// Words with no letters or digits match nothing in the index and are dropped.
func ftsQuery(_ query: String) -> String? {
    let words = query.split(whereSeparator: \.isWhitespace).filter { $0.contains { $0.isLetter || $0.isNumber } }
    guard !words.isEmpty else { return nil }
    return words.enumerated().map { i, w in
        "\"" + w.replacingOccurrences(of: "\"", with: "\"\"") + "\"" + (i == words.count - 1 ? "*" : "")
    }.joined(separator: " ")
}

/// Takes the match markers out, keeping where they were.
private func unmark(_ marked: String) -> (String, [Range<String.Index>]) {
    var plain = "", start: Int?, spans: [(Int, Int)] = []
    for ch in marked {
        if String(ch) == open { start = plain.utf16.count }
        else if String(ch) == close, let s = start { spans.append((s, plain.utf16.count)); start = nil }
        else { plain.append(ch) }
    }
    // offsets while building, indices only into the finished string
    return (plain, spans.map { String.Index(utf16Offset: $0.0, in: plain)..<String.Index(utf16Offset: $0.1, in: plain) })
}
