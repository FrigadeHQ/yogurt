import Foundation
import Testing
@testable import YogurtKit

@Suite struct StatusTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func labelsReadPlainly() {
        #expect(ConnectionStatus.notPaired.label(now: now) == "Not paired")
        #expect(ConnectionStatus.searching.label(now: now) == "Looking for your computer…")
        #expect(ConnectionStatus.connecting("MacBook").label(now: now) == "Connecting to MacBook…")
        #expect(ConnectionStatus.connected("MacBook", syncing: nil).label(now: now) == "Connected to MacBook · Synced just now")
        #expect(ConnectionStatus.connected("MacBook", syncing: 12).label(now: now) == "Syncing 12 meetings…")
        #expect(ConnectionStatus.connected("MacBook", syncing: 1).label(now: now) == "Syncing 1 meeting…")
        #expect(ConnectionStatus.connected("MacBook", syncing: 0).label(now: now) == "Syncing…")
        #expect(ConnectionStatus.error("Pair again.").label(now: now) == "Pair again.")
    }

    @Test func offlineSaysWhenItLastSynced() {
        func offline(_ ago: TimeInterval?) -> String {
            ConnectionStatus.offline("MacBook", lastSync: ago.map { now.addingTimeInterval(-$0) }).label(now: now)
        }
        #expect(offline(2 * 3600) == "Not on the same Wi-Fi · last synced 2 h ago")
        #expect(offline(20) == "Not on the same Wi-Fi · last synced just now")
        #expect(offline(5 * 60) == "Not on the same Wi-Fi · last synced 5 min ago")
        #expect(offline(30 * 3600) == "Not on the same Wi-Fi · last synced yesterday")
        #expect(offline(3 * 86400) == "Not on the same Wi-Fi · last synced 3 days ago")
        #expect(offline(nil) == "Not on the same Wi-Fi · not synced yet")
    }

    @Test func relativeTimeRoundsDownAndNeverGoesNegative() {
        #expect(relativeTime(now.addingTimeInterval(-59), now: now) == "just now")
        #expect(relativeTime(now.addingTimeInterval(-60), now: now) == "1 min ago")
        #expect(relativeTime(now.addingTimeInterval(-(3600 - 1)), now: now) == "59 min ago")
        #expect(relativeTime(now.addingTimeInterval(-3600), now: now) == "1 h ago")
        #expect(relativeTime(now.addingTimeInterval(-(48 * 3600 - 1)), now: now) == "yesterday")
        // a clock that moved back still reads as now
        #expect(relativeTime(now.addingTimeInterval(300), now: now) == "just now")
    }

    @Test func computerNameIsKnownOnceThereIsOne() {
        #expect(ConnectionStatus.notPaired.computerName == nil)
        #expect(ConnectionStatus.searching.computerName == nil)
        #expect(ConnectionStatus.connecting("Mac mini").computerName == "Mac mini")
        #expect(ConnectionStatus.connected("Mac mini", syncing: 3).computerName == "Mac mini")
        #expect(ConnectionStatus.offline("Mac mini", lastSync: nil).computerName == "Mac mini")
        #expect(ConnectionStatus.error("x").computerName == nil)
    }

    @Test func remoteAnswerDecodesTheAskReply() throws {
        let json = #"{"answer":"Bananas.","sources":[{"meetingId":"m1","title":"Fruit","atMs":1200,"text":"we chose bananas"},{"meetingId":"m2","title":"Plan","text":"more"}]}"#
        let a = try JSONDecoder().decode(RemoteAnswer.self, from: Data(json.utf8))
        #expect(a.answer == "Bananas.")
        #expect(a.sources.map(\.meetingId) == ["m1", "m2"])
        #expect(a.sources[0].atMs == 1200)
        #expect(a.sources[1].atMs == nil)
    }
}
