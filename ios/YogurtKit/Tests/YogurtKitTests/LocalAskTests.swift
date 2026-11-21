import Foundation
import Testing
@testable import YogurtKit

/// A stand-in for Apple's model: answers from a script and keeps every prompt it was given.
private actor AskModel: TextModel {
    private(set) var prompts: [String] = []
    private let answer: @Sendable (String, Int) throws -> String

    init(answer: @escaping @Sendable (String, Int) throws -> String) { self.answer = answer }

    func respond(to prompt: String, maxTokens: Int) async throws -> String {
        prompts.append(prompt)
        return try answer(prompt, prompts.count)
    }
}

private func meeting(_ id: String, _ title: String, at: Double, summary: String? = nil, mine: String = "", lines: [String] = []) -> String {
    let notes = summary.map { s in
        #",{"entity":"notes","id":"\#(id)","record":{"meetingId":"\#(id)","mine":"\#(mine)","summary":"\#(s)","mineHash":"h"}}"#
    } ?? ""
    let segs = lines.enumerated().map { i, t in #"{"startMs":\#(i * 60000),"endMs":\#(i * 60000 + 50000),"speaker":null,"text":"\#(t)"}"# }
        .joined(separator: ",")
    return #"{"entity":"meeting","id":"\#(id)","record":{"id":"\#(id)","title":"\#(title)","startedAt":\#(at),"endedAt":null,"attendees":[],"app":null,"trashedAt":null,"language":null}}"#
        + notes
        + (lines.isEmpty ? "" : #",{"entity":"segments","id":"\#(id)","record":{"meetingId":"\#(id)","segments":[\#(segs)]}}"#)
}

private func library() throws -> Store {
    let store = try Store(url: tempStoreURL())
    let day = 86_400_000.0
    try store.apply(changes("[" + [
        meeting("acme", "Acme renewal", at: 10 * day, summary: "## Pricing\\n- Acme pays 40 dollars a seat", lines: [
            "Hello everyone, thanks for joining.",
            "Acme wants a discount on the renewal budgets.",
            "We agreed on forty dollars a seat for the renewal.",
        ]),
        meeting("hire", "Hiring plan", at: 20 * day, summary: "## Roles\\n- Two engineers in March", lines: ["We need two engineers by March."]),
        meeting("lunch", "Team lunch", at: 30 * day, lines: ["The tacos were great."]),
        #"{"entity":"folder","id":"f1","record":{"id":"f1","name":"Sales","createdAt":1}}"#,
        #"{"entity":"folderMembers","id":"f1","record":{"folderId":"f1","meetingIds":["acme"]}}"#,
    ].joined(separator: ",") + "]"), cursor: 9)
    return store
}

@Suite struct LocalAskTests {
    @Test func picksThePassagesThatMatchTheQuestionNotEveryWord() throws {
        // "budget" is a word of the question, not every word: the meeting is still found, with its transcript part
        let passages = LocalAsk.passages(for: "What did we decide about the Acme budget?", scope: nil, in: try library())
        #expect(passages.first?.meetingId == "acme")
        #expect(passages.contains { $0.meetingId == "acme" && $0.atMs == 0 && $0.text.contains("renewal budgets") })
        #expect(!passages.contains { $0.meetingId == "lunch" })
    }

    @Test func keepsToTheScope() throws {
        let store = try library()
        let inFolder = LocalAsk.passages(for: "engineers", scope: AskScope(folderId: "f1"), in: store)
        #expect(!inFolder.contains { $0.meetingId == "hire" })
        let oneMeeting = LocalAsk.passages(for: "engineers", scope: AskScope(meetingIds: ["hire"]), in: store)
        #expect(Set(oneMeeting.map(\.meetingId)) == ["hire"])
    }

    @Test func withNothingMatchingItReadsTheNewestMeetingsInScope() throws {
        let passages = LocalAsk.passages(for: "How was this week?", scope: nil, in: try library())
        #expect(!passages.isEmpty)
        // newest first
        #expect(passages.first?.meetingId == "lunch")
        let one = LocalAsk.passages(for: "zzz qqq", scope: AskScope(meetingIds: ["acme"]), in: try library())
        #expect(one.first?.meetingId == "acme")
    }

    @Test func thePromptNumbersTheSourcesAndStaysWithinBudget() throws {
        let long = (0..<200).map { "Line \($0) about the Acme renewal budget and the price per seat." }
        let store = try Store(url: tempStoreURL())
        try store.apply(changes("[" + meeting("big", "Acme renewal", at: 1, summary: "Notes", lines: long) + "]"), cursor: 1)
        let passages = LocalAsk.passages(for: "Acme budget", scope: nil, in: store)
        let prompt = LocalAsk.prompt(question: "Acme budget?", passages: passages, now: Date(timeIntervalSince1970: 0))
        #expect(prompt.count <= LocalAsk.tokenBudget * LocalAsk.charsPerToken)
        #expect(prompt.contains("[1] "))
        #expect(prompt.contains("Meeting: Acme renewal"))
        #expect(prompt.hasSuffix("<question>\nAcme budget?\n</question>"))
        // what made it into the prompt is what the citations point at
        let used = LocalAsk.fitting(passages, question: "Acme budget?", now: Date(timeIntervalSince1970: 0))
        #expect(used.count < passages.count || prompt.contains("[\(passages.count)] "))
        #expect(prompt.contains("[\(used.count)] "))
        #expect(!prompt.contains("[\(used.count + 1)] "))
    }

    @Test func citationsMapToMeetingsAndMadeUpNumbersGo() {
        let passages = [
            AskPassage(meetingId: "a", title: "Acme", startedAt: Date(), atMs: nil, text: "notes"),
            AskPassage(meetingId: "a", title: "Acme", startedAt: Date(), atMs: 60000, text: "forty dollars"),
            AskPassage(meetingId: "b", title: "Hiring", startedAt: Date(), atMs: 0, text: "engineers"),
        ]
        let a = LocalAsk.answer("Acme pays **40 dollars** a seat [2][9]. Two engineers join [3, 2] .", passages: passages, by: .phone)
        // renumbered in the order they're first cited; [9] was never given out
        #expect(a.text == "Acme pays **40 dollars** a seat [1]. Two engineers join [2, 1].")
        #expect(a.sources.map(\.n) == [1, 2])
        #expect(a.sources.map(\.meetingId) == ["a", "b"])
        #expect(a.sources[0].atMs == 60000)
        #expect(a.by == .phone)
        let none = LocalAsk.answer("Nothing in your meetings says [7].", passages: passages, by: .phone)
        #expect(none.text == "Nothing in your meetings says.")
        #expect(none.sources.isEmpty)
    }

    @Test func asksTheModelAndShrinksWhenItDoesNotFit() async throws {
        let store = try library()
        let passages = LocalAsk.passages(for: "Acme budget", scope: nil, in: store)
        #expect(passages.count > 1)
        let model = AskModel { _, n in
            if n == 1 { throw TextModelError.tooLong }
            return "They agreed on forty dollars [1]."
        }
        let a = try await LocalAsk(model: model).answer(question: "Acme budget", passages: passages)
        #expect(a.text == "They agreed on forty dollars [1].")
        #expect(a.sources.first?.meetingId == "acme")
        let prompts = await model.prompts
        #expect(prompts.count == 2)
        #expect(prompts[1].count < prompts[0].count)
    }

    @Test func anEmptyAnswerIsAnError() async throws {
        let model = AskModel { _, _ in "  " }
        await #expect(throws: AskError.noAnswer) {
            try await LocalAsk(model: model).answer(question: "hi", passages: [])
        }
    }

    @Test func theComputersSourcesLineUpWithItsNumbers() {
        // the computer keeps only the sources it cited, in number order: [2] and [5] are its two sources
        let r = RemoteAnswer(answer: "Forty dollars [5]. Two engineers [2].", sources: [
            .init(meetingId: "hire", title: "Hiring", atMs: 0, text: "engineers"),
            .init(meetingId: "acme", title: "Acme", atMs: 60000, text: "forty"),
        ])
        let a = AskAnswer(remote: r)
        #expect(a.by == .computer)
        #expect(a.text == "Forty dollars [1]. Two engineers [2].")
        #expect(a.sources.map(\.meetingId) == ["acme", "hire"])
        // all of them sent: the numbers are their places
        let all = AskAnswer(remote: RemoteAnswer(answer: "Engineers [1].", sources: r.sources))
        #expect(all.sources.map(\.meetingId) == ["hire"])
    }

    @Test func theComputersSourceNumbersAreUsedWhenItSendsThem() {
        // the numbers say which is which, not their places: [7] is made up, though there is a third source
        let r = RemoteAnswer(answer: "Forty dollars [5]. Two engineers [2]. Made up [7].", sources: [
            .init(n: 2, meetingId: "hire", title: "Hiring", atMs: 0, text: "engineers"),
            .init(n: 5, meetingId: "acme", title: "Acme", atMs: 60000, text: "forty"),
            .init(n: 6, meetingId: "lunch", title: "Lunch", atMs: nil, text: "soup"),
        ])
        let a = AskAnswer(remote: r)
        #expect(a.text == "Forty dollars [1]. Two engineers [2]. Made up.")
        #expect(a.sources.map(\.meetingId) == ["acme", "hire"])
    }
}
