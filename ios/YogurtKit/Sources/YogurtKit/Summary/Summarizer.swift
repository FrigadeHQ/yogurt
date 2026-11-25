import Foundation
import os

private let log = Logger(subsystem: "chat.yogurt", category: "summary")

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
    /// the model wouldn't write about this text (a guardrail or a refusal); a smaller piece often goes through
    case refused
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
    /// the parts' notes used as the notes when the last step fails: about what desktop's notes run to
    static let fallbackChars = 2500

    public init(model: TextModel, language: String, maxChars: Int = 6000) {
        self.model = model; self.language = language; self.maxChars = maxChars
    }

    public func summarize(transcript: [Segment], myNotes: String) async throws -> String {
        let chunks = Chunker.chunks(transcript, maxChars: maxChars)
        guard !chunks.isEmpty else { throw SummaryError.nothingSaid }
        // desktop's length: from the first word to the last, rounded, never 0
        let first = transcript.map(\.startMs).min() ?? 0, last = transcript.map(\.endMs).max() ?? 0
        let minutes = max(1, Int((Double(last - first) / 60_000).rounded()))
        let mine = String(myNotes.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.myNotesLimit))
        if chunks.count == 1 {
            let prompt = NotesPrompt.notes(transcript: chunks[0], parts: false, myNotes: mine, minutes: minutes, language: language)
            do { return try notes(try await ask(prompt, maxTokens: Self.notesTokens)) } catch {
                // too long with the instructions, refused, or no notes in the answer: read it in two parts instead
                log.notice("notes in one go failed (\(String(describing: error), privacy: .public)); trying in parts")
            }
            return try await fromParts(halves(chunks[0]), mine: mine, minutes: minutes)
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

    /// One answer, asked again once after a passing failure. Too long and refused come back at once: a smaller piece
    /// is what helps there.
    private func ask(_ prompt: String, maxTokens: Int) async throws -> String {
        do { return try await model.respond(to: prompt, maxTokens: maxTokens) } catch let e as TextModelError { throw e } catch {
            log.notice("asking again after: \(String(describing: error), privacy: .public)")
            return try await model.respond(to: prompt, maxTokens: maxTokens)
        }
    }

    /// Every part that could be read counts: one bad part never costs the rest. With no part at all, it's an error.
    private func fromParts(_ chunks: [String], mine: String, minutes: Int) async throws -> String {
        var parts: [String] = []
        for chunk in chunks { parts += await summarizePart(chunk, startingAt: parts.count + 1, depth: 0) }
        guard !parts.isEmpty else { throw SummaryError.noNotes }
        // numbered as desktop does, so the last step reads them as parts of one meeting
        let numbered = parts.enumerated().map { "Part \($0.offset + 1):\n\($0.element)" }.joined(separator: "\n\n")
        let joined = await mergeUntilFits(numbered, limit: maxChars)
        var context = joined
        for _ in 0..<3 {
            let prompt = NotesPrompt.notes(transcript: context, parts: true, myNotes: mine, minutes: minutes, language: language)
            do { return try notes(try await ask(prompt, maxTokens: Self.notesTokens)) } catch TextModelError.tooLong {
                let shorter = await mergeUntilFits(context, limit: context.count / 2)
                if shorter.count >= context.count { break }
                context = shorter
            } catch {
                log.notice("the last step failed (\(String(describing: error), privacy: .public)); keeping the parts' notes")
                break
            }
        }
        // the parts' own notes are notes too, made shorter first: put one after another they'd run long
        return partsAsNotes(await mergeUntilFits(joined, limit: Self.fallbackChars))
    }

    /// Neighbouring parts' notes merged until they fit the limit. A group that can't be merged stays as it was.
    private func mergeUntilFits(_ text: String, limit: Int) async -> String {
        var joined = text
        var rounds = 0
        while joined.count > limit && rounds < 6 {
            var merged: [String] = []
            for group in Chunker.chunks(text: joined, maxChars: max(200, limit)) {
                let m = (try? await ask(NotesPrompt.merge(group, language: language), maxTokens: Self.partTokens)).map(cleanPart) ?? ""
                merged.append(m.isEmpty ? group : m)
            }
            let next = merged.joined(separator: "\n\n")
            if next.count >= joined.count { break }
            joined = next
            rounds += 1
        }
        if joined.count > maxChars {
            log.notice("part notes still \(joined.count, privacy: .public) characters after merging; the end is cut")
            joined = String(joined.prefix(maxChars))
        }
        return joined
    }

    /// One part's notes, or none. A part too long or refused is read in halves; a part that keeps failing is left out.
    private func summarizePart(_ chunk: String, startingAt n: Int, depth: Int) async -> [String] {
        do {
            let part = cleanPart(try await ask(NotesPrompt.part(chunk, number: n, language: language), maxTokens: Self.partTokens))
            return part.isEmpty ? [] : [part]
        } catch let e as TextModelError where depth < 3 && chunk.count > 200 {
            log.notice("part \(n, privacy: .public): \(String(describing: e), privacy: .public); reading it in halves")
            var out: [String] = []
            for half in halves(chunk) { out += await summarizePart(half, startingAt: n + out.count, depth: depth + 1) }
            return out
        } catch {
            log.notice("part \(n, privacy: .public) left out: \(String(describing: error), privacy: .public)")
            return []
        }
    }

    /// "### Topic" part notes as the notes' "## " sections, without the "Part 2:" labels.
    private func partsAsNotes(_ text: String) -> String {
        text.components(separatedBy: "\n")
            .filter { $0.range(of: #"^Part \d+:$"#, options: .regularExpression) == nil }
            .map { $0.hasPrefix("### ") ? String($0.dropFirst()) : $0 }.joined(separator: "\n")
            .replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
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

    /// A part's notes, or "" when the answer has none (an apology, a question back).
    private func cleanPart(_ raw: String) -> String {
        let n = cleanNotes(raw)
        return n.contains("- ") || n.contains("#") ? n : ""
    }
}

// MARK: - Prompts

/// Desktop's notes instructions (app/src/main/notes/enhance.ts), for a meeting heard on one iPhone in a room. Apple's
/// model writes longer than desktop's, so the length desktop gets from "a short meeting gets fewer sections" is said
/// as numbers here. Prompts go to the model, so they are never translated.
enum NotesPrompt {
    static func notes(transcript: String, parts: Bool, myNotes: String, minutes: Int, language: String) -> String {
        var p: [String] = []
        if parts {
            p += ["You will write the notes for a meeting that just ended. It was long, so here are notes on each part of it, in order:",
                  "<transcript>", transcript, "</transcript>",
                  "",
                  "These part notes overlap and repeat. Condense them into one set of notes with each topic once, keeping what matters later: not the parts one after another."]
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
              "How to write them, so they read at a glance:",
              "- Write in \(language), headings too.",
              "- Markdown only. Start right away with the first \"## \" topic: no title, no introduction, nothing after the last bullet.",
              "- Notes are about the work: plans, problems, numbers, prices, what was decided. Leave out small talk, greetings, personal chat and talk about the recording itself.",
              "- One \"## \" section per topic, most important first, named in a few specific words (like \"Pricing for Acme renewal\"), never \"Discussion\" or \"Updates\". Bring together what was said about one topic at different times.",
              "- Under each topic, \"- \" bullets with real substance: what was said, decided or proposed, and why. Keep names, numbers, prices, dates and tools. A bullet is one point of up to about 20 words, starting with the point (never \"The team discussed\"). More detail goes in \"  - \" bullets under it.",
              "- A decision or open question goes in its topic, said plainly (\"Decided: no paid ads for now\").",
              "- **Bold** rarely: a deadline, a big number or a key term, a few times in all.",
              "- Use a person's name only when the transcript says it. Never make up a name, a fact or a number.",
              "- Cover the whole meeting, the end as well. A short meeting gets fewer sections, not thinner ones.",
              length(minutes: minutes)]
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
         "Merge them into one shorter set of compact notes, in \(language), in the same shape: \"### \" lines naming each topic, with short \"- \" bullets. Bring together what was said about one topic and drop repeats; keep the decisions, tasks and concrete details that matter. Nothing else: no introduction, no closing line."].joined(separator: "\n")
    }

    /// How long the notes should be for a meeting this long. Desktop's notes run to about this (a few sections of a
    /// few bullets); Apple's model, told only "fewer sections", writes about twice as much.
    static func length(minutes: Int) -> String {
        let (sections, bullets, words): (String, String, Int) = switch minutes {
        case ..<15: ("1 to 3", "2 to 4", 150)
        case ..<35: ("2 to 4", "2 to 5", 250)
        case ..<75: ("3 to 5", "3 to 5", 350)
        default: ("4 to 6", "3 to 6", 450)
        }
        return "- Length: \(sections) \"## \" sections with \(bullets) bullets each, about \(words) words in all (next steps not counted). Brief beats complete: leave out a point that won't matter later rather than add one more bullet."
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
