import Foundation
import Testing
@testable import YogurtKit

/// A stand-in for Apple's model: answers from a script and keeps every prompt it was given.
private actor FakeModel: TextModel {
    private(set) var prompts: [String] = []
    private let answer: @Sendable (String, Int) throws -> String

    init(answer: @escaping @Sendable (String, Int) throws -> String) { self.answer = answer }

    func respond(to prompt: String, maxTokens: Int) async throws -> String {
        prompts.append(prompt)
        return try answer(prompt, prompts.count)
    }
}

private func seg(_ i: Int, _ text: String) -> Segment {
    Segment(index: i, startMs: i * 4000, endMs: i * 4000 + 3500, speaker: nil, text: text)
}

private func longTranscript(_ n: Int) -> [Segment] {
    (0..<n).map { seg($0, "Line \($0): we talked about the Acme renewal, the price of the pro plan and the launch date.") }
}

@Suite struct SummarizerTests {
    @Test func aShortMeetingIsWrittenInOneGo() async throws {
        let model = FakeModel { _, _ in "Sure! Here are the notes:\n## Launch date\n- Ship on **Thursday**" }
        let s = MapReduceSummarizer(model: model, language: "English")
        let notes = try await s.summarize(transcript: [seg(0, "We ship on Thursday."), seg(1, "Maya writes the post.")],
                                          myNotes: "ask about the post")
        // the chatter before the first heading is dropped
        #expect(notes == "## Launch date\n- Ship on **Thursday**")
        let prompts = await model.prompts
        #expect(prompts.count == 1)
        #expect(prompts[0].contains("We ship on Thursday.\nMaya writes the post."))
        #expect(prompts[0].contains("<notes>\nask about the post\n</notes>"))
        #expect(prompts[0].contains("## Next steps"))
        #expect(prompts[0].contains("Write in English"))
    }

    @Test func aLongMeetingIsSummarisedPerChunkThenCombinedOnce() async throws {
        let transcript = longTranscript(120)
        let chunks = Chunker.chunks(transcript, maxChars: 2000)
        #expect(chunks.count >= 3)
        let model = FakeModel { prompt, n in
            prompt.contains("Here is part") ? "### Part \(n)\n- detail \(n)" : "## Acme renewal\n- Price agreed"
        }
        let s = MapReduceSummarizer(model: model, language: "English", maxChars: 2000)
        let notes = try await s.summarize(transcript: transcript, myNotes: "renewal price?")
        #expect(notes == "## Acme renewal\n- Price agreed")

        let prompts = await model.prompts
        #expect(prompts.count == chunks.count + 1)
        // one call per chunk, in order, each with its own chunk only
        for (i, chunk) in chunks.enumerated() {
            #expect(prompts[i].contains("Here is part \(i + 1)"))
            #expect(prompts[i].contains(chunk))
            #expect(!prompts[i].contains("renewal price?"))
        }
        // then one call that combines every part's notes, steered by My notes
        let combine = prompts.last!
        for i in 1...chunks.count { #expect(combine.contains("### Part \(i)\n- detail \(i)")) }
        #expect(combine.contains("renewal price?"))
        #expect(!combine.contains("Line 0:"))
    }

    @Test func partsTooLongToCombineAreMergedInGroupsFirst() async throws {
        let transcript = longTranscript(200)
        // every part's notes are long, so all of them together are over the limit
        let model = FakeModel { prompt, n in
            if prompt.contains("Here is part") { return "### Part \(n)\n- " + String(repeating: "detail ", count: 120) }
            if prompt.contains("consecutive parts") { return "### Merged \(n)\n- short" }
            return "## Final\n- done"
        }
        let s = MapReduceSummarizer(model: model, language: "English", maxChars: 2000)
        #expect(try await s.summarize(transcript: transcript, myNotes: "") == "## Final\n- done")
        let prompts = await model.prompts
        #expect(prompts.contains { $0.contains("consecutive parts") })
        for p in prompts { #expect(p.count < 2000 + 4000) }
        #expect(!prompts.last!.contains("detail detail"))
    }

    @Test func tooLongForTheModelSplitsAndTriesAgain() async throws {
        let model = FakeModel { prompt, _ in
            // the model can't read anything over 1500 characters
            if prompt.count > 3200 { throw TextModelError.tooLong }
            return prompt.contains("Here is part") ? "### Bit\n- ok" : "## Notes\n- fine"
        }
        let s = MapReduceSummarizer(model: model, language: "English", maxChars: 6000)
        let notes = try await s.summarize(transcript: longTranscript(40), myNotes: "")
        #expect(notes == "## Notes\n- fine")
    }

    @Test func nothingSaidIsNothingToWrite() async {
        let model = FakeModel { _, _ in "## x" }
        let s = MapReduceSummarizer(model: model, language: "English")
        await #expect(throws: SummaryError.nothingSaid) { try await s.summarize(transcript: [seg(0, " ")], myNotes: "hi") }
        #expect(await model.prompts.isEmpty)
    }

    @Test func anEmptyAnswerIsAnError() async {
        let model = FakeModel { _, _ in "Sorry, I can't help with that." }
        let s = MapReduceSummarizer(model: model, language: "English")
        await #expect(throws: SummaryError.noNotes) { try await s.summarize(transcript: [seg(0, "Hello there.")], myNotes: "") }
    }

    @Test func titleComesFromTheNotesAndIsTidied() async throws {
        let model = FakeModel { _, _ in "Title: \"Acme renewal pricing.\"" }
        let s = MapReduceSummarizer(model: model, language: "English")
        let title = try await s.title(notes: "## Acme renewal\n- Price agreed", transcript: [])
        #expect(title == "Acme renewal pricing")
        #expect(await model.prompts[0].contains("## Acme renewal"))
    }

    @Test func titleFromTheFirstLinesWhenThereAreNoNotes() async throws {
        let model = FakeModel { _, _ in "**Budget check-in**" }
        let s = MapReduceSummarizer(model: model, language: "English")
        let title = try await s.title(notes: nil, transcript: longTranscript(300))
        #expect(title == "Budget check-in")
        let prompt = await model.prompts[0]
        #expect(prompt.contains("Line 0:"))
        #expect(!prompt.contains("Line 299:"))
    }

    @Test func cleanTitleLimits() {
        #expect(cleanTitle("") == "")
        #expect(cleanTitle("# Weekly sync") == "Weekly sync")
        #expect(cleanTitle("Weekly sync\nSecond line") == "Weekly sync")
        let long = cleanTitle(String(repeating: "word ", count: 40))
        #expect(long.count <= 70)
        #expect(!long.hasSuffix(" "))
    }

    @Test func cleanNotesKeepsOnlyTheMarkdownNotes() {
        #expect(cleanNotes("```markdown\n## A\n- b\n```") == "## A\n- b")
        #expect(cleanNotes("Here you go:\n\n## A\n- b\n\nLet me know if you need more.") == "## A\n- b")
        #expect(cleanNotes("- just bullets") == "- just bullets")
        #expect(cleanNotes("   ") == "")
    }
}
