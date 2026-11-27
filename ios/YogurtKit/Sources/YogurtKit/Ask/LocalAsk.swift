import Foundation

/// A piece of a meeting the answer can use and cite: a part of its transcript (atMs: where it starts) or its notes (atMs nil).
public struct AskPassage: Sendable, Hashable {
    public var meetingId: String
    public var title: String
    public var startedAt: Date
    public var atMs: Int?
    public var text: String
    public init(meetingId: String, title: String, startedAt: Date, atMs: Int?, text: String) {
        self.meetingId = meetingId; self.title = title; self.startedAt = startedAt; self.atMs = atMs; self.text = text
    }
}

/// What a [n] in an answer points at.
public struct AskSource: Sendable, Hashable, Identifiable, Codable {
    public var n: Int
    public var meetingId: String
    public var title: String
    /// where in the meeting; nil for its notes
    public var atMs: Int?
    public var excerpt: String
    public var id: Int { n }
}

/// An answer across meetings, its citations numbered 1, 2… in the order they first show, each matching a source.
public struct AskAnswer: Sendable, Hashable, Codable {
    public enum By: Sendable, Hashable, Codable { case phone, computer }
    public var text: String
    public var sources: [AskSource]
    public var by: By
}

public enum AskError: Error, Equatable {
    /// the model wrote nothing
    case noAnswer
}

/// Ask on the phone, with Apple's model: the best-matching passages from the Store, a prompt that fits the model's
/// ~4,000 tokens, and the model's [n] citations mapped back to meetings. Like desktop's Ask (app/src/main/library),
/// with search in place of its embeddings.
public struct LocalAsk: Sendable {
    /// what the prompt may take of the model's context, leaving room for the answer
    public static let tokenBudget = 3500
    /// a cautious guess for English; a prompt that still doesn't fit is retried with fewer passages
    public static let charsPerToken = 4
    static let answerTokens = 500
    static let partChars = 1000
    static let notesChars = 1500
    static let maxMeetings = 8
    static let maxPassages = 14

    let model: TextModel
    public init(model: TextModel) { self.model = model }

    // MARK: - Finding passages

    /// The passages that best match the question, best first. With nothing matching (or no words to look for), the
    /// newest meetings in scope, so "how was this week?" still has something to go on.
    public static func passages(for question: String, scope: AskScope?, in store: Store) -> [AskPassage] {
        let allowed = allowedMeetings(scope, store)
        let terms = searchTerms(question)
        // a meeting scores for each word of the question found in it, more for a better match
        var score: [String: Double] = [:]
        for query in [question] + terms {
            for (rank, hit) in store.search(query, limit: 30).enumerated() where allowed.contains(hit.meetingId) {
                score[hit.meetingId, default: 0] += 1 + 0.5 / Double(rank + 1)
            }
        }
        let byRecency = store.meetings().filter { allowed.contains($0.id) }
        let found = byRecency.filter { score[$0.id] != nil }
            .sorted { score[$0.id]! > score[$1.id]! }
            .prefix(maxMeetings)
        guard !found.isEmpty else { return recent(Array(byRecency.prefix(4)), store) }

        var ranked: [(passage: AskPassage, score: Double, meeting: Int)] = []
        for (rank, m) in found.enumerated() {
            for p in meetingPassages(m, store) {
                var s = matchScore(p.text, terms)
                // a meeting's notes are its overview: worth reading for the best few meetings even without the words
                if p.atMs == nil && rank < 3 { s += 0.5 + matchScore(m.title, terms) }
                if s > 0 { ranked.append((p, s, rank)) }
            }
        }
        if ranked.isEmpty { return recent(Array(found), store) }
        return ranked.sorted {
            $0.score != $1.score ? $0.score > $1.score : $0.meeting != $1.meeting ? $0.meeting < $1.meeting : ($0.passage.atMs ?? -1) < ($1.passage.atMs ?? -1)
        }.prefix(maxPassages).map(\.passage)
    }

    private static func allowedMeetings(_ scope: AskScope?, _ store: Store) -> Set<String> {
        var ids = Set(store.meetings(folder: scope?.folderId).map(\.id))
        if let only = scope?.meetingIds { ids.formIntersection(only) }
        return ids
    }

    /// Newest first: each meeting's notes (or, without notes, the start of what was said), then the rest of them.
    private static func recent(_ meetings: [Meeting], _ store: Store) -> [AskPassage] {
        let each = meetings.map { meetingPassages($0, store) }
        return Array((each.compactMap(\.first) + each.flatMap { $0.dropFirst() }).prefix(maxPassages))
    }

    /// The notes (summary and My notes) as one passage, and the transcript in parts of about a thousand characters.
    static func meetingPassages(_ m: Meeting, _ store: Store) -> [AskPassage] {
        var out: [AskPassage] = []
        let notes = store.notes(m.id)
        let summary = notes?.summary?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let mine = notes?.mine.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let notesText = [summary, mine.isEmpty ? "" : "Their own notes:\n" + mine].filter { !$0.isEmpty }.joined(separator: "\n")
        if !notesText.isEmpty {
            out.append(AskPassage(meetingId: m.id, title: m.title, startedAt: m.startedAt, atMs: nil, text: String(notesText.prefix(notesChars))))
        }
        var text = "", start: Int?
        func flush() {
            if let start, !text.isEmpty { out.append(AskPassage(meetingId: m.id, title: m.title, startedAt: m.startedAt, atMs: start, text: text)) }
            text = ""; start = nil
        }
        for s in store.segments(m.id) {
            guard let line = Chunker.line(s) else { continue }
            if !text.isEmpty && text.count + 1 + line.count > partChars { flush() }
            if start == nil { start = s.startMs }
            text = text.isEmpty ? String(line.prefix(partChars)) : text + "\n" + line
        }
        flush()
        return out
    }

    /// The question's words worth looking for, each cut to its stem so "budgets" finds "budget" (search matches a
    /// word's start).
    static func searchTerms(_ question: String) -> [String] {
        let words = question.lowercased().split { !($0.isLetter || $0.isNumber || $0 == "'") }.map(String.init)
        var out: [String] = []
        for w in words where !stopWords.contains(w) && (w.count > 2 || w.allSatisfy(\.isNumber)) {
            let stem = stem(w)
            if !out.contains(stem) { out.append(stem) }
        }
        return out
    }

    private static func stem(_ w: String) -> String {
        guard w.count > 4 else { return w }
        for suffix in ["ing", "ed", "es", "s"] where w.hasSuffix(suffix) && w.count - suffix.count >= 4 {
            return String(w.dropLast(suffix.count))
        }
        return w
    }

    /// two points for each word found, plus one for each further time it shows (up to three)
    private static func matchScore(_ text: String, _ terms: [String]) -> Double {
        let lower = text.lowercased()
        return terms.reduce(0) { total, t in
            let n = lower.components(separatedBy: t).count - 1
            return total + (n > 0 ? 2 + Double(min(n - 1, 3)) : 0)
        }
    }

    static let stopWords: Set<String> = [
        "the", "and", "for", "are", "was", "were", "what", "when", "where", "who", "whom", "why", "how", "did", "does",
        "do", "has", "have", "had", "that", "this", "these", "those", "with", "about", "from", "into", "our", "your", "you",
        "they", "them", "their", "there", "then", "than", "can", "could", "would", "should", "will", "shall", "any", "all",
        "some", "tell", "said", "say", "says", "talk", "talked", "meeting", "meetings", "which", "been", "being", "its",
        "it's", "is", "be", "of", "to", "in", "on", "at", "by", "or", "an", "a", "we", "us", "me", "my", "i", "not", "but",
        "so", "if", "out", "up", "get", "got", "give", "please", "show", "know", "anything", "something", "ever", "last",
    ]

    // MARK: - The prompt

    /// The passages that fit in the prompt, taken best first, then grouped meeting by meeting (its notes, then its
    /// parts in the order they were said) as the model reads them. A [n] in the answer is the nth of these.
    public static func fitting(_ ranked: [AskPassage], question: String, now: Date) -> [AskPassage] {
        let limit = tokenBudget * charsPerToken
        var kept: [AskPassage] = []
        for p in ranked {
            if render(question: question, passages: byMeeting(kept + [p]), now: now).count <= limit { kept.append(p) }
        }
        // the best passage alone too long (a huge notes field): its start, so there's always something to read
        if kept.isEmpty, var first = ranked.first {
            let room = limit - render(question: question, passages: [], now: now).count - 200
            if room > 200 { first.text = String(first.text.prefix(room)); kept = [first] }
        }
        return byMeeting(kept)
    }

    public static func prompt(question: String, passages ranked: [AskPassage], now: Date) -> String {
        render(question: question, passages: fitting(ranked, question: question, now: now), now: now)
    }

    private static func byMeeting(_ items: [AskPassage]) -> [AskPassage] {
        var order: [String] = [], groups: [String: [AskPassage]] = [:]
        for p in items {
            if groups[p.meetingId] == nil { order.append(p.meetingId) }
            groups[p.meetingId, default: []].append(p)
        }
        return order.flatMap { groups[$0]!.sorted { ($0.atMs ?? -1) < ($1.atMs ?? -1) } }
    }

    // Desktop's libraryHead (app/src/main/library/prompt.ts), shortened for Apple's small model. Prompts go to the
    // model, so they are never translated.
    static let head = [
        "You answer questions about the person's own meetings. Below are parts of their meetings found for the question, grouped by meeting, each numbered like [1]: pieces of transcripts, or the notes written after a meeting. In a transcript, \"You\" is the person asking.",
        "",
        "How to answer:",
        "- Answer in the language the question is written in.",
        "- Use only what is in the sources. Never make anything up.",
        "- Say the sources don't hold the answer (in one sentence, with no numbers) only when nothing in them is about the question.",
        "- After each fact, put the number of the source it came from in square brackets, like [2]. Use only the numbers given.",
        "- Be brief and direct: a sentence or two, or short \"- \" bullets for a list. **Bold** only the key facts. No headings, no introduction, no closing line.",
        "- Use a person's name only when the sources say it.",
        "",
        "<sources>",
    ].joined(separator: "\n")

    private static func render(question: String, passages: [AskPassage], now: Date) -> String {
        var parts: [String] = []
        for (k, p) in passages.enumerated() {
            let heading = k == 0 || passages[k - 1].meetingId != p.meetingId
                ? "Meeting: \(p.title.isEmpty ? "Untitled" : p.title) · \(day(p.startedAt))\n" : ""
            let label = p.atMs.map { "\(clock($0)) into the meeting" } ?? "the meeting notes"
            parts.append("\(heading)[\(k + 1)] \(label)\n\(p.text)")
        }
        let meetings = Set(passages.map(\.meetingId)).count
        let sources = passages.isEmpty ? "No meetings matched this question."
            : "These come from \(meetings) \(meetings == 1 ? "meeting" : "meetings").\n\n" + parts.joined(separator: "\n\n")
        return [head, sources, "</sources>", "", "Today is \(day(now)).",
                "Answer the question below from the sources, with their numbers like [1].", "",
                "<question>", String(question.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1000)), "</question>"].joined(separator: "\n")
    }

    private static func day(_ d: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "EEEE, MMMM d, yyyy"
        return f.string(from: d)
    }

    /// 4:05, or 1:02:03 an hour in
    static func clock(_ ms: Int) -> String {
        let s = max(0, ms / 1000)
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
    }

    // MARK: - Asking

    /// Asks the model over the passages (best first). When the prompt doesn't fit after all, it tries again with
    /// the better half.
    public func answer(question: String, passages ranked: [AskPassage], now: Date = Date()) async throws -> AskAnswer {
        var ranked = ranked
        while true {
            let used = Self.fitting(ranked, question: question, now: now)
            do {
                let raw = try await model.respond(to: Self.render(question: question, passages: used, now: now), maxTokens: Self.answerTokens)
                let a = Self.answer(raw, passages: used, by: .phone)
                guard !a.text.isEmpty else { throw AskError.noAnswer }
                return a
            } catch TextModelError.tooLong where ranked.count > 1 {
                ranked = Array(ranked.prefix(ranked.count / 2))
            }
        }
    }

    /// The model's answer with its citations mapped to the passages it was given. Numbers it made up are dropped.
    public static func answer(_ raw: String, passages: [AskPassage], by: AskAnswer.By) -> AskAnswer {
        let (text, sources) = renumber(raw) { n in
            guard n >= 1, n <= passages.count else { return nil }
            let p = passages[n - 1]
            return Cited(key: n, meetingId: p.meetingId, title: p.title, atMs: p.atMs, excerpt: p.text)
        }
        return AskAnswer(text: text, sources: sources, by: by)
    }
}

extension AskAnswer {
    /// The computer's answer. Each source carries the number its citations use. An older desktop sent them without:
    /// then, when it sent fewer than the answer's biggest number, the nth smallest number cited is the nth source.
    public init(remote r: RemoteAnswer) {
        if r.sources.allSatisfy({ $0.n != nil }) {
            let byNumber = Dictionary(r.sources.enumerated().map { ($1.n!, $0) }, uniquingKeysWith: { first, _ in first })
            let (text, sources) = renumber(r.answer) { n in
                guard let i = byNumber[n] else { return nil }
                let s = r.sources[i]
                return Cited(key: i, meetingId: s.meetingId, title: s.title, atMs: s.atMs, excerpt: s.text)
            }
            self.init(text: text, sources: sources, by: .computer)
            return
        }
        let cited = Array(Set(citedNumbers(r.answer))).sorted()
        let all = (cited.last ?? 0) <= r.sources.count
        let place: [Int: Int] = all ? [:] : Dictionary(uniqueKeysWithValues: cited.enumerated().map { ($1, $0) })
        let (text, sources) = renumber(r.answer) { n in
            guard let i = all ? n - 1 : place[n], i >= 0, i < r.sources.count else { return nil }
            let s = r.sources[i]
            return Cited(key: i, meetingId: s.meetingId, title: s.title, atMs: s.atMs, excerpt: s.text)
        }
        self.init(text: text, sources: sources, by: .computer)
    }
}

// MARK: - Citations

struct Cited { var key: Int; var meetingId: String; var title: String; var atMs: Int?; var excerpt: String }

private var citation: Regex<(Substring, Substring)> { /\[(\d+(?:\s*,\s*\d+)*)\]/ }

private func numbers(_ inner: Substring) -> [Int] { inner.split(separator: ",").compactMap { Int($0.trimmingCharacters(in: .whitespaces)) } }

func citedNumbers(_ text: String) -> [Int] { text.matches(of: citation).flatMap { numbers($0.output.1) } }

/// Each [n] numbered again 1, 2… in the order first cited, with a source for each; numbers `lookup` doesn't know go.
func renumber(_ raw: String, lookup: (Int) -> Cited?) -> (String, [AskSource]) {
    var sources: [AskSource] = [], newNumber: [Int: Int] = [:]
    var text = raw.replacing(citation) { m in
        var kept: [Int] = []
        for n in numbers(m.output.1) {
            guard let c = lookup(n) else { continue }
            let k: Int
            if let known = newNumber[c.key] { k = known } else {
                k = sources.count + 1
                newNumber[c.key] = k
                sources.append(AskSource(n: k, meetingId: c.meetingId, title: c.title, atMs: c.atMs, excerpt: c.excerpt))
            }
            if !kept.contains(k) { kept.append(k) }
        }
        return kept.isEmpty ? "" : "[" + kept.map(String.init).joined(separator: ", ") + "]"
    }
    text = text.replacing(/\ +([.,;:!?])/) { String($0.output.1) }
        .replacing(/[ \t]{2,}/, with: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    return (text, sources)
}
