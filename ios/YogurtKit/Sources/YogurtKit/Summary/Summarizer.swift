import Foundation

/// Writes a meeting's notes as Markdown in desktop Yogurt's shape: a "## " section per topic with "- " bullets, and
/// "## Next steps" when someone said they would do something.
public protocol Summarizer: Sendable {
    func summarize(transcript: [Segment], myNotes: String) async throws -> String
}

/// One prompt in, one answer out. Apple's on-device model in the app; a stand-in in tests.
public protocol TextModel: Sendable {
    func respond(to prompt: String, maxTokens: Int) async throws -> String
}

public enum TextModelError: Error, Equatable {
    /// the prompt and answer don't fit in what the model can read at once
    case tooLong
}

public enum SummaryError: Error, Equatable {
    /// the transcript has no words
    case nothingSaid
    /// the model answered with no notes in it
    case noNotes
}

/// Summarise each chunk of a long meeting, then write the notes from those parts, as desktop does for meetings longer
/// than its model can read (enhance.ts). Apple's model reads about 4,000 tokens, so most meetings take this path.
public struct MapReduceSummarizer: Summarizer {
    let model: TextModel
    /// "English": the language the notes are written in
    let language: String
    let maxChars: Int

    /// My notes are hints; a very long page of them would crowd out the meeting
    static let myNotesLimit = 1500
    static let notesTokens = 900
    static let partTokens = 400

    public init(model: TextModel, language: String, maxChars: Int = 6000) {
        self.model = model; self.language = language; self.maxChars = maxChars
    }

    public func summarize(transcript: [Segment], myNotes: String) async throws -> String {
        let chunks = Chunker.chunks(transcript, maxChars: maxChars)
        guard !chunks.isEmpty else { throw SummaryError.nothingSaid }
        let minutes = (transcript.map(\.endMs).max() ?? 0) / 60000
        let mine = String(myNotes.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.myNotesLimit))
        if chunks.count == 1 {
            do {
                return try notes(try await model.respond(to: NotesPrompt.notes(transcript: chunks[0], parts: false, myNotes: mine,
                                                                               minutes: minutes, language: language),
                                                         maxTokens: Self.notesTokens))
            } catch TextModelError.tooLong {
                // it didn't fit with the instructions: read it in two parts instead
                return try await fromParts(halves(chunks[0]), mine: mine, minutes: minutes)
            }
        }
        return try await fromParts(chunks, mine: mine, minutes: minutes)
    }

    /// A short title, from the notes when they're written, else from the first lines of the transcript.
    public func title(notes: String?, transcript: [Segment]) async throws -> String {
        let context: String
        if let notes, !notes.isEmpty {
            context = "Here are the notes of a meeting:\n<notes>\n\(notes.prefix(maxChars))\n</notes>"
        } else {
            let first = Chunker.chunks(transcript, maxChars: 1500).first ?? ""
            guard !first.isEmpty else { throw SummaryError.nothingSaid }
            context = "Here is how a meeting started:\n<transcript>\n\(first)\n</transcript>"
        }
        let raw = try await model.respond(to: context + "\n\n" + NotesPrompt.title(language: language), maxTokens: 40)
        let title = cleanTitle(raw)
        guard !title.isEmpty else { throw SummaryError.noNotes }
        return title
    }

    // MARK: - Map, then reduce

    private func fromParts(_ chunks: [String], mine: String, minutes: Int) async throws -> String {
        var parts: [String] = []
        for chunk in chunks { parts += try await summarizePart(chunk, startingAt: parts.count + 1, depth: 0) }
        // all the parts together must fit too: merge neighbours until they do
        var joined = parts.joined(separator: "\n\n")
        var rounds = 0
        while joined.count > maxChars && rounds < 4 {
            var merged: [String] = []
            for group in Chunker.chunks(text: joined, maxChars: maxChars) {
                merged.append(cleanPart(try await model.respond(to: NotesPrompt.merge(group, language: language), maxTokens: Self.partTokens)))
            }
            joined = merged.filter { !$0.isEmpty }.joined(separator: "\n\n")
            rounds += 1
        }
        guard !joined.isEmpty else { throw SummaryError.noNotes }
        let prompt = NotesPrompt.notes(transcript: String(joined.prefix(maxChars)), parts: true, myNotes: mine, minutes: minutes, language: language)
        return try notes(try await model.respond(to: prompt, maxTokens: Self.notesTokens))
    }

    /// One part's notes. A part the model can't read at once is read in halves.
    private func summarizePart(_ chunk: String, startingAt n: Int, depth: Int) async throws -> [String] {
        do {
            let part = cleanPart(try await model.respond(to: NotesPrompt.part(chunk, number: n, language: language), maxTokens: Self.partTokens))
            return part.isEmpty ? [] : [part]
        } catch TextModelError.tooLong where depth < 4 && chunk.count > 200 {
            var out: [String] = []
            for half in halves(chunk) { out += try await summarizePart(half, startingAt: n + out.count, depth: depth + 1) }
            return out
        }
    }

    private func halves(_ text: String) -> [String] {
        let pieces = Chunker.chunks(text: text, maxChars: max(100, text.count / 2 + 1))
        return pieces.count > 1 ? pieces : Chunker.cut(text, max(1, text.count / 2 + 1))
    }

    private func notes(_ raw: String) throws -> String {
        let n = cleanNotes(raw)
        guard n.contains("- ") || n.contains("#") else { throw SummaryError.noNotes }
        return n
    }

    private func cleanPart(_ raw: String) -> String { cleanNotes(raw) }
}

// MARK: - Prompts

/// Desktop's notes instructions (app/src/main/notes/enhance.ts), shortened for a small model, for a meeting heard on
/// one iPhone in a room. Prompts go to the model, so they are never translated.
enum NotesPrompt {
    static func notes(transcript: String, parts: Bool, myNotes: String, minutes: Int, language: String) -> String {
        var p: [String] = []
        if parts {
            p += ["You will write the notes for a meeting that just ended. It was long, so here are notes on each part of it, in order:",
                  "<transcript>", transcript, "</transcript>"]
        } else {
            p += ["Here is the transcript of a meeting, recorded on one iPhone in a room, so the lines don't say who spoke:",
                  "<transcript>", transcript, "</transcript>"]
        }
        p += ["",
              "Write the notes for this meeting, which just ended, for the person who recorded it (\"You\") to read later: the work that was talked about, what was decided, and who will do what."]
        if minutes > 0 { p.append("Length: about \(minutes) minute\(minutes == 1 ? "" : "s").") }
        if !myNotes.isEmpty {
            p += ["", "Notes they typed during the meeting. They show what they care about and facts they know. They are hints, not text to copy:",
                  "<notes>", myNotes, "</notes>"]
        }
        p += ["",
              "How to write them:",
              "- Write in \(language), headings too.",
              "- Markdown only. Start right away with the first \"## \" topic: no title, no introduction, nothing after the last bullet.",
              "- One \"## \" section per topic, most important first, named in a few specific words (like \"Pricing for Acme renewal\"), never \"Discussion\" or \"Updates\".",
              "- Under each topic, \"- \" bullets with real substance: what was said, decided or proposed, and why. Keep names, numbers, prices, dates and tools. One point per bullet, up to about 20 words.",
              "- A decision or open question goes in its topic, said plainly (\"Decided: no paid ads for now\").",
              "- Leave out small talk, greetings and talk about the recording itself.",
              "- Use a person's name only when the transcript says it. Never make up a name, a fact or a number.",
              "- Cover the whole meeting, the end as well. A short meeting gets fewer sections, not thinner ones."]
        if !myNotes.isEmpty {
            p.append("- What their notes flag gets a topic or a bullet of its own, in your own words. Never copy their lines or give their notes a section of their own.")
        }
        p += ["- Last, \"## Next steps\" only if someone said they would do something after the meeting: one bullet each, as \"- **Name:** what they will do, by when\". Otherwise leave it out.",
              "",
              "The shape:",
              "## <topic>",
              "- <point>",
              "  - <detail>",
              "## Next steps",
              "- **<Name>:** <task>"]
        return p.joined(separator: "\n")
    }

    static func part(_ chunk: String, number: Int, language: String) -> String {
        ["Here is part \(number) of a long meeting's transcript, recorded on one iPhone in a room:",
         "<transcript>", chunk, "</transcript>",
         "",
         "Write compact notes on this part only, in \(language): every topic discussed with its concrete details (numbers, dates, names, tools), what was decided, open questions, and who agreed to do what.",
         "Short \"- \" bullets grouped under a \"### \" line naming the topic. Nothing else: no introduction, no closing line."].joined(separator: "\n")
    }

    static func merge(_ group: String, language: String) -> String {
        ["Here are notes on consecutive parts of a long meeting, in order:",
         "<notes>", group, "</notes>",
         "",
         "Merge them into one set of compact notes, in \(language), in the same shape: \"### \" lines naming each topic, with short \"- \" bullets. Bring together what was said about one topic, keep every concrete detail, decision and task. Nothing else: no introduction, no closing line."].joined(separator: "\n")
    }

    static func title(language: String) -> String {
        "Now give this meeting a title, in \(language): short and specific, saying what it was about, like \"Q3 hiring plan\" or \"Fixing the checkout bug\". Under 70 characters, no quotes, no period at the end. Answer with the title only. Never name the person these notes are for."
    }
}

// MARK: - Tidying the model's answers

/// The notes without what a chatty model adds around them: code fences, "Here are the notes:", "Let me know…".
public func cleanNotes(_ raw: String) -> String {
    var lines = raw.components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("```") }
    let isNote = { (l: String) -> Bool in
        let t = l.trimmingCharacters(in: .whitespaces)
        return t.hasPrefix("#") || t.hasPrefix("- ") || t.hasPrefix("* ") || t.first?.isNumber == true && t.contains(". ")
    }
    if let first = lines.firstIndex(where: isNote) { lines.removeFirst(first) }
    // a closing paragraph after the last bullet, set apart by a blank line
    if let last = lines.lastIndex(where: isNote), let blank = lines[last...].firstIndex(where: { $0.trimmingCharacters(in: .whitespaces).isEmpty }) {
        lines.removeSubrange(blank...)
    }
    return lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
}

/// The title as the model wrote it, without quotes, a "Title:" label, heading or bold marks, or a closing period;
/// cut at a word to 70 characters. Like desktop's cleanTitle.
public func cleanTitle(_ raw: String) -> String {
    var s = raw.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n").first ?? ""
    s = s.replacingOccurrences(of: #"^#+\s*"#, with: "", options: .regularExpression)
    s = s.replacingOccurrences(of: #"^(?:\*\*)?title(?:\*\*)?\s*:\s*"#, with: "", options: [.regularExpression, .caseInsensitive])
    s = s.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "__", with: "")
    s = s.trimmingCharacters(in: CharacterSet(charactersIn: "\"'“”‘’`").union(.whitespaces))
    while s.hasSuffix(".") || s.hasSuffix("。") { s.removeLast() }
    s = s.trimmingCharacters(in: CharacterSet(charactersIn: "\"'“”‘’`").union(.whitespaces))
    if s.count > 70 {
        let cut = String(s.prefix(70))
        s = cut.lastIndex(of: " ").map { String(cut[..<$0]) } ?? cut
    }
    return s.trimmingCharacters(in: .whitespaces)
}
