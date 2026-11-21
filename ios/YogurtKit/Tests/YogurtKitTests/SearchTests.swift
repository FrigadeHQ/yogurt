import Foundation
import Testing
@testable import YogurtKit

@Suite struct SearchTests {
    func filled() throws -> Store {
        let store = try Store(url: tempStoreURL())
        try store.apply(changes("""
        [
          {"entity":"meeting","id":"m1","record":{"id":"m1","title":"Banana sync","startedAt":1000,"endedAt":2000,"attendees":[],"app":null,"trashedAt":null,"language":null}},
          {"entity":"notes","id":"m1","record":{"meetingId":"m1","mine":"ask about the mango budget","summary":"The team chose papaya for the launch.","mineHash":"h"}},
          {"entity":"segments","id":"m1","record":{"meetingId":"m1","segments":[{"startMs":0,"endMs":900,"speaker":"me","text":"let us talk about the kumquat order"},{"startMs":1000,"endMs":1900,"speaker":null,"text":"sounds good"}]}},
          {"entity":"meeting","id":"m2","record":{"id":"m2","title":"Weekly kumquat review","startedAt":5000,"endedAt":null,"attendees":[],"app":null,"trashedAt":null,"language":null}}
        ]
        """), cursor: 4)
        return store
    }

    @Test func findsWordsInEachFieldWithASnippet() throws {
        let store = try filled()
        let title = try #require(store.search("banana", limit: 10).first)
        #expect(title.meetingId == "m1")
        #expect(title.title == "Banana sync")
        #expect(title.field == .title)

        let mine = try #require(store.search("mango", limit: 10).first)
        #expect(mine.field == .mine)
        #expect(mine.snippet.contains("mango budget"))
        #expect(mine.highlights.map { String(mine.snippet[$0]) } == ["mango"])

        #expect(store.search("papaya", limit: 10).first?.field == .summary)
        let said = try #require(store.search("order", limit: 10).first)
        #expect(said.field == .transcript)
        #expect(said.snippet.contains("kumquat order"))
    }

    @Test func aTitleMatchRanksAboveATranscriptMatch() throws {
        let hits = try filled().search("kumquat", limit: 10)
        #expect(hits.map(\.meetingId) == ["m2", "m1"])
        #expect(hits.map(\.field) == [.title, .transcript])
    }

    @Test func allWordsMustMatchAndTheLastCanBeUnfinished() throws {
        let store = try filled()
        #expect(store.search("ban", limit: 10).map(\.meetingId) == ["m1"])
        #expect(store.search("kumquat order", limit: 10).map(\.meetingId) == ["m1"])
        #expect(store.search("kumquat nothing", limit: 10).isEmpty)
        #expect(try filled().search("kumquat", limit: 1).count == 1)
    }

    @Test func oddInputNeverThrows() throws {
        let store = try filled()
        for q in ["", "   ", "\"", "\"banana", "banana\"", "AND", "banana OR", "(banana", "title:banana", "*", "^banana", "NEAR(banana", "-", "a-b", "don't", "banana:*"] {
            _ = store.search(q, limit: 10)
            // search() hides errors, so check SQLite takes the cleaned query itself
            if let match = ftsQuery(q) {
                #expect(throws: Never.self) { try store.db.query("SELECT meeting_id FROM search WHERE search MATCH ?", [.text(match)]) }
            }
        }
        #expect(store.search("\"banana\"", limit: 10).map(\.meetingId) == ["m1"])
        #expect(store.search("title:banana", limit: 10).isEmpty)
        #expect(store.search("", limit: 10).isEmpty)
    }

    @Test func theIndexFollowsChangesTrashAndDeletes() throws {
        let store = try filled()
        try store.apply(changes("""
        [{"entity":"meeting","id":"m1","record":{"id":"m1","title":"Apple sync","startedAt":1000,"endedAt":2000,"attendees":[],"app":null,"trashedAt":null,"language":null}},
         {"entity":"segments","id":"m1","record":{"meetingId":"m1","segments":[]}},
         {"entity":"meeting","id":"m2","record":{"id":"m2","title":"Weekly kumquat review","startedAt":5000,"endedAt":null,"attendees":[],"app":null,"trashedAt":7000,"language":null}}]
        """), cursor: 5)
        #expect(store.search("banana", limit: 10).isEmpty)
        #expect(store.search("apple", limit: 10).map(\.meetingId) == ["m1"])
        #expect(store.search("kumquat", limit: 10).isEmpty)
        #expect(store.search("mango", limit: 10).map(\.meetingId) == ["m1"])

        try store.apply(changes(#"[{"entity":"meeting","id":"m1","deleted":true}]"#), cursor: 6)
        #expect(store.search("mango", limit: 10).isEmpty)
    }

    @Test func aPhoneEditIsFoundAtOnce() throws {
        let store = try filled()
        try store.editMine(meetingId: "m1", text: "call the plumber")
        #expect(store.search("plumber", limit: 10).first?.field == .mine)
        #expect(store.search("mango", limit: 10).isEmpty)
    }
}
