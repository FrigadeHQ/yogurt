import Foundation
import Testing
@testable import YogurtKit

/// A fresh database file in a temp folder, so reopen tests read the real file back.
func tempStoreURL() -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("yogurtkit-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("store.sqlite")
}

/// Changes as the desktop sends them on `pull` (app/src/main/companion/records.ts).
func changes(_ json: String) throws -> [Change] {
    try JSONDecoder().decode([Change].self, from: Data(json.utf8))
}

let pageOne = """
[
  {"entity":"meeting","id":"m1","record":{"id":"m1","title":"Banana sync","startedAt":1000,"endedAt":2000,"attendees":[{"name":"Ada Example","email":"ada@example.com"}],"app":"Zoom","trashedAt":null,"language":null}},
  {"entity":"notes","id":"m1","record":{"meetingId":"m1","mine":"buy apples","summary":"We agreed on bananas.","mineHash":"hash-a"}},
  {"entity":"segments","id":"m1","record":{"meetingId":"m1","segments":[{"startMs":0,"endMs":900,"speaker":"me","text":"hello there"},{"startMs":1000,"endMs":1900,"speaker":null,"text":"hi back"}]}},
  {"entity":"meeting","id":"m2","record":{"id":"m2","title":"Cherry review","startedAt":5000,"endedAt":null,"attendees":[],"app":null,"trashedAt":null,"language":"fr"}},
  {"entity":"folder","id":"f1","record":{"id":"f1","name":"Fruit","createdAt":300}},
  {"entity":"folderMembers","id":"f1","record":{"folderId":"f1","meetingIds":["m1"]}},
  {"entity":"people","id":"ada@example.com","record":{"email":"ada@example.com","displayName":"Ada"}}
]
"""

@Suite struct StoreTests {
    @Test func aPageOfChangesInsertsEverything() throws {
        let store = try Store(url: tempStoreURL())
        try store.apply(changes(pageOne), cursor: 7)

        #expect(store.meetings(folder: nil).map(\.id) == ["m2", "m1"])
        let m1 = try #require(store.meeting("m1"))
        #expect(m1.title == "Banana sync")
        #expect(m1.startedAt == Date(timeIntervalSince1970: 1))
        #expect(m1.endedAt == Date(timeIntervalSince1970: 2))
        #expect(m1.attendees == [Attendee(name: "Ada Example", email: "ada@example.com")])
        #expect(m1.app == "Zoom")
        #expect(store.meeting("m2")?.language == "fr")
        #expect(store.meeting("m2")?.endedAt == nil)

        let notes = try #require(store.notes("m1"))
        #expect(notes.mine == "buy apples")
        #expect(notes.summary == "We agreed on bananas.")
        #expect(notes.summarySource == .desktop)

        #expect(store.segments("m1").map(\.text) == ["hello there", "hi back"])
        #expect(store.segments("m1").map(\.speaker) == ["me", nil])
        #expect(store.segments("m1")[1].startMs == 1000)

        #expect(store.folders().map(\.name) == ["Fruit"])
        #expect(store.meetings(folder: "f1").map(\.id) == ["m1"])
        #expect(store.people() == [Person(email: "ada@example.com", displayName: "Ada")])
        #expect(store.cursor == 7)
    }

    @Test func laterChangesUpdateAndTombstonesDelete() throws {
        let store = try Store(url: tempStoreURL())
        try store.apply(changes(pageOne), cursor: 7)
        try store.apply(changes("""
        [
          {"entity":"meeting","id":"m1","record":{"id":"m1","title":"Banana sync, again","startedAt":1000,"endedAt":2000,"attendees":[],"app":"Zoom","trashedAt":null,"language":null}},
          {"entity":"segments","id":"m1","record":{"meetingId":"m1","segments":[{"startMs":0,"endMs":10,"speaker":"me","text":"only line"}]}},
          {"entity":"meeting","id":"m2","deleted":true},
          {"entity":"notes","id":"m2","deleted":true},
          {"entity":"folder","id":"f1","deleted":true},
          {"entity":"folderMembers","id":"f1","deleted":true},
          {"entity":"people","id":"ada@example.com","deleted":true}
        ]
        """), cursor: 14)

        #expect(store.meeting("m1")?.title == "Banana sync, again")
        #expect(store.segments("m1").map(\.text) == ["only line"])
        #expect(store.meeting("m2") == nil)
        #expect(store.meetings(folder: nil).map(\.id) == ["m1"])
        #expect(store.folders().isEmpty)
        #expect(store.meetings(folder: "f1").isEmpty)
        #expect(store.people().isEmpty)
        #expect(store.cursor == 14)
    }

    @Test func aDeletedMeetingTakesItsNotesAndTranscriptWithIt() throws {
        let store = try Store(url: tempStoreURL())
        try store.apply(changes(pageOne), cursor: 7)
        try store.apply(changes(#"[{"entity":"meeting","id":"m1","deleted":true}]"#), cursor: 8)
        #expect(store.notes("m1") == nil)
        #expect(store.segments("m1").isEmpty)
        #expect(store.meetings(folder: "f1").isEmpty)
    }

    @Test func trashedMeetingsLeaveTheListButCanBeShown() throws {
        let store = try Store(url: tempStoreURL())
        try store.apply(changes(pageOne), cursor: 7)
        try store.apply(changes("""
        [{"entity":"meeting","id":"m1","record":{"id":"m1","title":"Banana sync","startedAt":1000,"endedAt":2000,"attendees":[],"app":null,"trashedAt":9000,"language":null}}]
        """), cursor: 8)
        #expect(store.meetings(folder: nil).map(\.id) == ["m2"])
        #expect(store.meetings(folder: "f1").isEmpty)
        #expect(store.meetings(folder: nil, trashed: true).map(\.id) == ["m1"])
        #expect(store.meeting("m1")?.trashedAt == Date(timeIntervalSince1970: 9))
    }

    @Test func anEntityThisVersionDoesNotKnowIsSkipped() throws {
        let store = try Store(url: tempStoreURL())
        try store.apply(changes(#"[{"entity":"reminders","id":"r1","record":{"x":1}},{"entity":"reminders","id":"r2","deleted":true}]"#), cursor: 3)
        #expect(store.cursor == 3)
        #expect(store.meetings(folder: nil).isEmpty)
    }

    @Test func cursorAndEpochPersistAcrossReopen() throws {
        let url = tempStoreURL()
        do {
            let store = try Store(url: url)
            #expect(store.cursor == 0)
            #expect(store.epoch == nil)
            try store.apply(changes(pageOne), cursor: 42, epoch: "epoch-1")
        }
        let again = try Store(url: url)
        #expect(again.cursor == 42)
        #expect(again.epoch == "epoch-1")
        #expect(again.meeting("m1")?.title == "Banana sync")
    }

    @Test func aQueuedEditSurvivesReopenAndLeavesOnceSent() throws {
        let url = tempStoreURL()
        do {
            let store = try Store(url: url)
            try store.apply(changes(pageOne), cursor: 7)
            try store.enqueue(PendingOp(Op(kind: .rename, meetingId: "m1", title: "Bananas")))
            try store.enqueue(PendingOp(Op(kind: .addToFolder, meetingId: "m2", folderId: "f1")))
        }
        let again = try Store(url: url)
        let ops = again.pendingOps()
        #expect(ops.map(\.op.kind) == [.rename, .addToFolder])
        #expect(ops[0].op.title == "Bananas")
        #expect(ops[1].op.folderId == "f1")
        try again.markSent(ops[0].id)
        #expect(again.pendingOps().map(\.id) == [ops[1].id])
    }

    @Test func anOpEncodesAsTheWireBody() throws {
        let op = Op(kind: .setMine, meetingId: "m1", text: "hi", baseHash: "abc")
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(op)) as? [String: String]
        #expect(json == ["kind": "setMine", "meetingId": "m1", "text": "hi", "baseHash": "abc"])
    }

    @Test func editingMyNotesShowsAtOnceAndCarriesTheDesktopHash() throws {
        let store = try Store(url: tempStoreURL())
        try store.apply(changes(pageOne), cursor: 7)
        try store.editMine(meetingId: "m1", text: "buy apples and pears")
        #expect(store.notes("m1")?.mine == "buy apples and pears")
        let op = try #require(store.pendingOps().first)
        #expect(op.op.kind == .setMine)
        #expect(op.op.text == "buy apples and pears")
        #expect(op.op.baseHash == "hash-a")
    }

    @Test func setMineEditsForOneMeetingCoalesce() throws {
        let store = try Store(url: tempStoreURL())
        try store.apply(changes(pageOne), cursor: 7)
        try store.editMine(meetingId: "m1", text: "one")
        // the desktop's hash moved on meanwhile: the queued edit still started from the old one
        try store.apply(changes(#"[{"entity":"notes","id":"m1","record":{"meetingId":"m1","mine":"desk","summary":null,"mineHash":"hash-b"}}]"#), cursor: 8)
        try store.editMine(meetingId: "m2", text: "other meeting")
        try store.editMine(meetingId: "m1", text: "one two")
        let ops = store.pendingOps()
        #expect(ops.count == 2)
        #expect(ops[0].op.meetingId == "m1")
        #expect(ops[0].op.text == "one two")
        #expect(ops[0].op.baseHash == "hash-a")
        #expect(ops[1].op.meetingId == "m2")
    }

    @Test func anotherOpInBetweenStopsCoalescing() throws {
        let store = try Store(url: tempStoreURL())
        try store.apply(changes(pageOne), cursor: 7)
        try store.editMine(meetingId: "m1", text: "one")
        try store.enqueue(PendingOp(Op(kind: .rename, meetingId: "m1", title: "Bananas")))
        try store.editMine(meetingId: "m1", text: "one two")
        #expect(store.pendingOps().map(\.op.kind) == [.setMine, .rename, .setMine])
    }

    @Test func anEditWhileTheLastOneIsOnItsWayIsNotLost() throws {
        let store = try Store(url: tempStoreURL())
        try store.apply(changes(pageOne), cursor: 7)
        try store.editMine(meetingId: "m1", text: "one")
        let sending = try #require(store.pendingOps().first)
        try store.editMine(meetingId: "m1", text: "one two")
        // the desktop says ok for the first text: the newer one must stay queued, based on what the desktop now has
        try store.markSent(sending.id)
        let left = store.pendingOps()
        #expect(left.count == 1)
        #expect(left[0].op.text == "one two")
        #expect(left[0].op.baseHash == notesHash("one"))
        try store.markSent(left[0].id)
        #expect(store.pendingOps().isEmpty)
    }

    @Test func aMergedReplyLeavesTheBaseHashAlone() throws {
        let store = try Store(url: tempStoreURL())
        try store.apply(changes(pageOne), cursor: 7)
        try store.editMine(meetingId: "m1", text: "one")
        let sending = try #require(store.pendingOps().first)
        try store.editMine(meetingId: "m1", text: "one two")
        try store.markSent(sending.id, merged: true)
        #expect(store.pendingOps().first?.op.baseHash == "hash-a")
    }

    @Test func notesHashMatchesTheDesktop() {
        // sha256 hex of the NFC text, as notesHash in records.ts
        #expect(notesHash("hello") == "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
        #expect(notesHash("caf\u{E9}") == notesHash("cafe\u{301}"))
    }

    @Test func aDesktopRecordKeepsMyNotesWhileAnEditIsPending() throws {
        let store = try Store(url: tempStoreURL())
        try store.apply(changes(pageOne), cursor: 7)
        try store.editMine(meetingId: "m1", text: "typed on the phone")
        try store.apply(changes("""
        [{"entity":"notes","id":"m1","record":{"meetingId":"m1","mine":"typed on the desktop","summary":"New summary.","mineHash":"hash-b"}},
         {"entity":"segments","id":"m1","record":{"meetingId":"m1","segments":[{"startMs":0,"endMs":10,"speaker":"me","text":"newer line"}]}}]
        """), cursor: 8)
        #expect(store.notes("m1")?.mine == "typed on the phone")
        #expect(store.notes("m1")?.summary == "New summary.")
        #expect(store.segments("m1").map(\.text) == ["newer line"])

        try store.markSent(try #require(store.pendingOps().first).id)
        try store.apply(changes(#"[{"entity":"notes","id":"m1","record":{"meetingId":"m1","mine":"merged text","summary":"New summary.","mineHash":"hash-c"}}]"#), cursor: 9)
        #expect(store.notes("m1")?.mine == "merged text")
        try store.editMine(meetingId: "m1", text: "next")
        #expect(store.pendingOps().first?.op.baseHash == "hash-c")
    }

    @Test func aPhoneRecordingIsADraftUntilTheDesktopWritesItsOwn() throws {
        let store = try Store(url: tempStoreURL())
        let rec = LocalRecording(
            id: "p1", title: "Walk and talk", startedAt: Date(timeIntervalSince1970: 10), endedAt: Date(timeIntervalSince1970: 70),
            attendees: [], audioURL: URL(fileURLWithPath: "/tmp/p1.m4a"), myNotes: "remember the kiwis",
            transcript: [.init(startMs: 0, endMs: 500, text: "draft words")], summary: "Draft summary.")
        try store.saveLocalRecording(rec)

        #expect(store.meeting("p1")?.title == "Walk and talk")
        #expect(store.notes("p1")?.summarySource == .phoneDraft)
        #expect(store.notes("p1")?.summary == "Draft summary.")
        #expect(store.notes("p1")?.mine == "remember the kiwis")
        #expect(store.segments("p1").map(\.text) == ["draft words"])
        #expect(store.localRecordings() == [rec])

        // the desktop took it in but has not written its notes or transcript yet: the draft stays on screen
        try store.apply(changes("""
        [{"entity":"meeting","id":"p1","record":{"id":"p1","title":"Walk and talk","startedAt":10000,"endedAt":70000,"attendees":[],"app":null,"trashedAt":null,"language":null}},
         {"entity":"notes","id":"p1","record":{"meetingId":"p1","mine":"remember the kiwis","summary":null,"mineHash":"h"}},
         {"entity":"segments","id":"p1","record":{"meetingId":"p1","segments":[]}}]
        """), cursor: 3)
        #expect(store.notes("p1")?.summarySource == .phoneDraft)
        #expect(store.notes("p1")?.summary == "Draft summary.")
        #expect(store.segments("p1").map(\.text) == ["draft words"])

        try store.apply(changes("""
        [{"entity":"notes","id":"p1","record":{"meetingId":"p1","mine":"remember the kiwis","summary":"Desktop summary.","mineHash":"h"}},
         {"entity":"segments","id":"p1","record":{"meetingId":"p1","segments":[{"startMs":0,"endMs":400,"speaker":null,"text":"desktop words"}]}}]
        """), cursor: 4)
        #expect(store.notes("p1")?.summarySource == .desktop)
        #expect(store.notes("p1")?.summary == "Desktop summary.")
        #expect(store.segments("p1").map(\.text) == ["desktop words"])
    }

    @Test func aRecordingIsMarkedUploaded() throws {
        let url = tempStoreURL()
        let at = Date(timeIntervalSince1970: 1_800_000_000)
        do {
            let store = try Store(url: url)
            try store.saveLocalRecording(LocalRecording(
                id: "p1", title: "Walk", startedAt: Date(timeIntervalSince1970: 10), endedAt: nil, attendees: [],
                audioURL: URL(fileURLWithPath: "/tmp/p1.m4a"), myNotes: "", transcript: [], summary: nil))
            try store.markUploaded("p1", at: at)
        }
        #expect(try Store(url: url).localRecordings().first?.uploadedAt == at)
    }

    @Test func aNewEpochClearsTheDesktopDataButKeepsThePhonesOwn() throws {
        let store = try Store(url: tempStoreURL())
        try store.apply(changes(pageOne), cursor: 7, epoch: "epoch-1")
        try store.editMine(meetingId: "m1", text: "typed on the phone")
        try store.saveLocalRecording(LocalRecording(
            id: "p1", title: "Walk", startedAt: Date(timeIntervalSince1970: 10), endedAt: nil, attendees: [],
            audioURL: URL(fileURLWithPath: "/tmp/p1.m4a"), myNotes: "kiwis", transcript: [], summary: "Draft."))

        try store.resetForNewEpoch()
        #expect(store.cursor == 0)
        #expect(store.epoch == nil)
        #expect(store.meetings(folder: nil).map(\.id) == ["p1"])
        #expect(store.notes("p1")?.summarySource == .phoneDraft)
        #expect(store.folders().isEmpty)
        #expect(store.people().isEmpty)
        #expect(store.pendingOps().map(\.op.text) == ["typed on the phone"])
        #expect(store.localRecordings().map(\.id) == ["p1"])
        #expect(store.search("bananas", limit: 10).isEmpty)

        // the new desktop's notes for m1 arrive while the edit is still queued: the phone's text shows
        try store.apply(changes(pageOne), cursor: 5, epoch: "epoch-2")
        #expect(store.epoch == "epoch-2")
        #expect(store.notes("m1")?.mine == "typed on the phone")
    }
}
