import Foundation
import Testing
@testable import YogurtKit

@MainActor @Suite struct SyncEngineTests {
    @Test func pullsPageAfterPageUntilThereIsNoMore() async throws {
        let rig = try Rig { d in for i in 1...5 { d.addMeeting("m\(i)", title: "Meeting \(i)", startedAt: i * 1000) } }
        rig.engine.setForeground(true)
        #expect(await eventually { rig.store.meetings().count == 5 && rig.connected })
        #expect(rig.desktop.requests("pull").map { $0["since"] as? Int } == [0, 2, 4])
        #expect(rig.store.cursor == 5)
        #expect(rig.store.epoch == "epoch-1")
        // screens re-read the Store once per page
        #expect(rig.engine.revision >= 3)
    }

    @Test func aConnectionDroppedMidPullResumesFromTheStoredCursor() async throws {
        let rig = try Rig { d in for i in 1...6 { d.addMeeting("m\(i)", title: "Meeting \(i)") } }
        var dropped = false
        rig.desktop.dropWhen = { type, body in
            guard type == "pull", body["since"] as? Int == 2, !dropped else { return false }
            dropped = true
            return true
        }
        rig.engine.setForeground(true)
        #expect(await eventually { rig.store.meetings().count == 6 && rig.connected })
        #expect(rig.desktop.requests("pull").map { $0["since"] as? Int } == [0, 2, 2, 4])
        #expect(rig.network.opens == 2)
    }

    @Test func pendingOpsGoInOrderAndAreClearedOnlyOnceTheDesktopSaysOk() async throws {
        let rig = try Rig { d in d.addMeeting("m1", title: "One"); d.addMeeting("m2", title: "Two") }
        try rig.store.apply(changes(#"[{"entity":"meeting","id":"m1","record":{"id":"m1","title":"One","startedAt":1000}},{"entity":"meeting","id":"m2","record":{"id":"m2","title":"Two","startedAt":1000}}]"#), cursor: 2, epoch: "epoch-1")
        let ops = [PendingOp(Op(kind: .rename, meetingId: "m1", title: "A")), PendingOp(Op(kind: .rename, meetingId: "m2", title: "B")),
                   PendingOp(Op(kind: .trash, meetingId: "m1"))]
        for op in ops { try rig.store.enqueue(op) }
        // the second op's answer never comes: the connection drops
        var dropped = false
        rig.desktop.dropWhen = { type, body in
            guard type == "op", body["meetingId"] as? String == "m2", !dropped else { return false }
            #expect(rig.store.pendingOps().map(\.id) == [ops[1].id, ops[2].id])
            dropped = true
            return true
        }
        rig.engine.setForeground(true)
        #expect(await eventually { rig.store.pendingOps().isEmpty && rig.connected })
        let sent = rig.desktop.requests("op").map { "\($0["kind"] as? String ?? "") \($0["meetingId"] as? String ?? "")" }
        #expect(sent == ["rename m1", "rename m2", "rename m2", "trash m1"])
    }

    @Test func aMergedReplyIsPassedOnAndTheNotesArePulledAgain() async throws {
        let rig = try Rig { d in d.addMeeting("m1", title: "One"); d.addNotes("m1", mine: "desk text") }
        rig.engine.setForeground(true)
        #expect(await eventually { rig.connected })
        try rig.store.editMine(meetingId: "m1", text: "phone text")
        rig.desktop.opReply = { _ in .success(["applied": true, "merged": true]) }
        await rig.engine.syncNow()
        #expect(rig.store.pendingOps().isEmpty)
        // the desktop may not echo a merge, so its copy is fetched again from the start
        #expect(rig.desktop.requests("pull").last?["since"] as? Int == 0)
        #expect(rig.store.notes("m1")?.mine == "desk text")
    }

    @Test func aRefusedRenameIsDroppedAndTheDesktopTitleComesBack() async throws {
        let rig = try Rig { d in d.addMeeting("m1", title: "Desk title") }
        rig.engine.setForeground(true)
        #expect(await eventually { rig.connected })
        rig.desktop.opReply = { _ in .failure(.remote("bad-op")) }
        try rig.store.enqueue(PendingOp(Op(kind: .rename, meetingId: "m1", title: "")))
        #expect(rig.store.meeting("m1")?.title == "")
        await rig.engine.syncNow()
        #expect(rig.store.pendingOps().isEmpty)
        #expect(rig.store.meeting("m1")?.title == "Desk title")
    }

    @Test func goneOpsAreDroppedUnlessTheirRecordingIsStillOnItsWay() async throws {
        let rig = try Rig { d in d.addMeeting("m1", title: "One") }
        try rig.store.apply(changes(#"[{"entity":"meeting","id":"m1","record":{"id":"m1","title":"One","startedAt":1000}}]"#), cursor: 1, epoch: "epoch-1")
        let rec = LocalRecording(id: "p1", title: "Walk", startedAt: Date(timeIntervalSince1970: 10), endedAt: nil, attendees: [],
                                 audioURL: URL(fileURLWithPath: "/nonexistent/p1.m4a"), myNotes: "", transcript: [], summary: nil)
        try rig.store.saveLocalRecording(rec)
        try rig.store.editMine(meetingId: "p1", text: "draft notes")
        try rig.store.enqueue(PendingOp(Op(kind: .rename, meetingId: "p1", title: "Walk home")))
        try rig.store.enqueue(PendingOp(Op(kind: .trash, meetingId: "m1")))
        rig.desktop.opReply = { _ in .failure(.remote("gone")) }
        rig.engine.setForeground(true)
        #expect(await eventually { rig.connected && rig.desktop.requests("op").count == 2 })
        // the rename waits behind the held edit, so the desktop gets them in order once the recording is in
        #expect(rig.desktop.requests("op").map { $0["kind"] as? String } == ["setMine", "trash"])
        #expect(rig.store.pendingOps().map(\.op.kind) == [.setMine, .rename])
    }

    @Test func anUploadCutOffAfterChunkThreeStartsOverAndTheDesktopGetsOneMeeting() async throws {
        let rig = try Rig()
        let audio = Data((0..<50).map { UInt8($0) })
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("p1-\(UUID().uuidString).m4a")
        try audio.write(to: url)
        var cut = false
        rig.desktop.dropWhen = { type, body in
            guard type == "uploadAudio", body["index"] as? Int == 3, !cut else { return false }
            cut = true
            return true
        }
        rig.engine.setForeground(true)
        #expect(await eventually { rig.connected })
        let rec = LocalRecording(id: "p1", title: "Walk", startedAt: Date(timeIntervalSince1970: 10), endedAt: Date(timeIntervalSince1970: 70),
                                 attendees: [Attendee(name: "Ada", email: nil)], audioURL: url, myNotes: "remember kiwis",
                                 transcript: [.init(startMs: 0, endMs: 900, text: "hello")], summary: "Draft.")
        try await rig.engine.upload(rec)
        #expect(await eventually { rig.store.localRecordings().first?.uploadedAt != nil })
        #expect(rig.desktop.imported == ["p1": 1])
        #expect(rig.desktop.importedAudio["p1"] == audio)
        let indexes = rig.desktop.requests("uploadAudio").map { $0["index"] as? Int ?? -1 }
        #expect(indexes == [0, 1, 2, 3, 0, 1, 2, 3, 4])
        let meeting = try #require(rig.desktop.requests("uploadMeeting").first)
        #expect((meeting["meeting"] as? [String: Any])?["endedAt"] as? Int == 70_000)
        #expect(meeting["myNotes"] as? String == "remember kiwis")
        #expect(meeting["summary"] as? String == "Draft.")
    }

    @Test func aMeetingTheDesktopAlreadyHasSendsNoAudio() async throws {
        let rig = try Rig()
        rig.desktop.imported["p1"] = 1
        let rec = LocalRecording(id: "p1", title: "Walk", startedAt: Date(timeIntervalSince1970: 10), endedAt: Date(timeIntervalSince1970: 20), attendees: [],
                                 audioURL: URL(fileURLWithPath: "/nonexistent/p1.m4a"), myNotes: "", transcript: [], summary: nil)
        try rig.store.saveLocalRecording(rec)
        rig.engine.setForeground(true)
        #expect(await eventually { rig.store.localRecordings().first?.uploadedAt != nil })
        #expect(rig.desktop.requests("uploadAudio").isEmpty)
    }

    @Test func aNewEpochStartsTheCopyAfresh() async throws {
        let rig = try Rig { d in d.addMeeting("m1", title: "New one"); d.epoch = "epoch-2" }
        try rig.store.apply(changes(#"[{"entity":"meeting","id":"old","record":{"id":"old","title":"Old","startedAt":1000}}]"#), cursor: 40, epoch: "epoch-1")
        rig.engine.setForeground(true)
        #expect(await eventually { rig.connected && rig.store.meetings().map(\.id) == ["m1"] })
        #expect(rig.desktop.requests("pull").first?["since"] as? Int == 0)
        #expect(rig.store.epoch == "epoch-2")
    }

    @Test func aChangedPushPullsAgain() async throws {
        let rig = try Rig { d in d.addMeeting("m1", title: "One") }
        rig.engine.setForeground(true)
        #expect(await eventually { rig.connected && rig.store.meetings().count == 1 })
        rig.desktop.addMeeting("m2", title: "Two")
        rig.desktop.sessions.last?.onChanged?()
        #expect(await eventually { rig.store.meetings().count == 2 })
    }

    @Test func askAndAudioGoThroughTheSession() async throws {
        let rig = try Rig { d in d.audioFiles["m1"] = Data("made-up audio bytes".utf8) }
        await #expect(throws: SyncError.notConnected) { try await rig.engine.ask("why?", scope: nil) }
        rig.engine.setForeground(true)
        #expect(await eventually { rig.connected })
        let answer = try await rig.engine.ask("Which fruit?", scope: AskScope(meetingIds: ["m1"]))
        #expect(answer.answer == "Made-up answer to: Which fruit?")
        #expect(answer.sources.first?.atMs == 1200)
        #expect((rig.desktop.requests("ask").first?["scope"] as? [String: Any])?["meetingIds"] as? [String] == ["m1"])
        let url = try await rig.engine.audioURL(meetingId: "m1")
        #expect(try Data(contentsOf: url) == Data("made-up audio bytes".utf8))
        // fetched once
        _ = try await rig.engine.audioURL(meetingId: "m1")
        #expect(rig.desktop.requests("audio").count == 1)
    }
}

@MainActor @Suite struct SyncStatusTests {
    @Test func noKeysMeansNotPairedAndTheComputersOnTheWiFiAreListed() async throws {
        let rig = try Rig(paired: false)
        #expect(rig.engine.status == .notPaired)
        rig.engine.setForeground(true)
        rig.engine.lookForComputers(true)
        #expect(await eventually { rig.engine.discovered.map(\.id) == ["desk-1"] })
        #expect(rig.engine.status == .notPaired)
        #expect(rig.network.opens == 0)
    }

    @Test func unpairedItLooksForComputersOnlyWhenAsked() async throws {
        // looking makes iOS ask for the local network, so it waits until the person chose to connect
        let rig = try Rig(paired: false)
        rig.engine.setForeground(true)
        try await Task.sleep(for: .milliseconds(50))
        #expect(!rig.network.isBrowsing)
        #expect(rig.engine.discovered.isEmpty)
        rig.engine.lookForComputers(true)
        #expect(await eventually { rig.engine.discovered.map(\.id) == ["desk-1"] })
        rig.engine.lookForComputers(false)
        #expect(!rig.network.isBrowsing)
        #expect(rig.engine.discovered.isEmpty)
        // asked while in the background: it starts once Yogurt is on screen
        rig.engine.setForeground(false)
        rig.engine.lookForComputers(true)
        #expect(!rig.network.isBrowsing)
        rig.engine.setForeground(true)
        #expect(await eventually { rig.network.isBrowsing })
    }

    @Test func unpairingStopsLookingUnlessAsked() async throws {
        let rig = try Rig { d in d.addMeeting("m1", title: "One") }
        rig.engine.setForeground(true)
        #expect(await eventually { rig.connected })
        rig.engine.unpair()
        #expect(!rig.network.isBrowsing)
        #expect(rig.engine.discovered.isEmpty)
    }

    @Test func aPairingMadeWhileLookingKeepsLookingAfterTheConnectScreenCloses() async throws {
        let rig = try Rig(paired: false)
        rig.engine.setForeground(true)
        rig.engine.lookForComputers(true)
        #expect(await eventually { !rig.engine.discovered.isEmpty })
        try await rig.engine.pair(with: rig.engine.discovered[0], code: "123456")
        rig.engine.lookForComputers(false)
        #expect(rig.network.isBrowsing)
        #expect(await eventually { rig.connected })
    }

    @Test func pairedButNotFoundSearchesThenSaysOfflineWithTheLastSync() async throws {
        let rig = try Rig()
        rig.network.shown = []
        let last = Date(timeIntervalSince1970: 1_800_000_000)
        rig.defaults.set(last.timeIntervalSince1970, forKey: "yogurt.sync.lastSync")
        rig.engine.setForeground(true)
        #expect(rig.engine.status == .searching)
        #expect(await eventually { rig.engine.status == .offline("Test Mac", lastSync: last) })
    }

    @Test func theHandshakeShowsConnectingThenPullingShowsHowManyMeetings() async throws {
        let rig = try Rig { d in for i in 1...3 { d.addMeeting("m\(i)", title: "Meeting \(i)") } }
        let handshake = Gate(), secondPage = Gate()
        rig.network.holdOpen = { await handshake.wait() }
        rig.desktop.hold = { type, body in if type == "pull", body["since"] as? Int == 2 { await secondPage.wait() } }
        rig.engine.setForeground(true)
        #expect(await eventually { rig.engine.status == .connecting("Test Mac") })
        handshake.open()
        #expect(await eventually { rig.engine.status == .connected("Test Mac", syncing: 2) })
        #expect(rig.engine.status.label == "Syncing 2 meetings…")
        secondPage.open()
        #expect(await eventually { rig.engine.status == .connected("Test Mac", syncing: nil) })
        #expect(rig.engine.status.label == "Connected to Test Mac · Synced just now")
    }

    @Test func aRefusedKeySaysToPairAgain() async throws {
        let rig = try Rig()
        rig.network.openError = .unrecognised
        rig.engine.setForeground(true)
        #expect(await eventually { rig.engine.status == .error("This computer doesn't recognise this iPhone any more. Pair again.") })
        // and stops trying until something changes
        let tries = rig.network.opens
        try await Task.sleep(for: .milliseconds(100))
        #expect(rig.network.opens == tries)
    }

    @Test func oneRefusalThatWasReallyADropDoesNotSayPairAgain() async throws {
        let rig = try Rig()
        rig.network.openError = .unrecognised
        rig.network.holdOpen = { [network = rig.network] in if network.opens == 2 { network.openError = nil } }
        rig.engine.setForeground(true)
        #expect(await eventually { rig.connected })
    }

    @Test func aComputerThatCanNotBeReachedIsRetriedAndGoesOfflineThenConnectsWhenBack() async throws {
        let rig = try Rig()
        rig.network.openError = .timeout
        rig.engine.setForeground(true)
        #expect(await eventually { if case .offline = rig.engine.status { true } else { false } })
        #expect(rig.network.opens > 1)
        rig.network.openError = nil
        #expect(await eventually { rig.connected })
    }

    @Test func aDroppedSessionLooksAgainAndReconnects() async throws {
        let rig = try Rig()
        rig.engine.setForeground(true)
        #expect(await eventually { rig.connected })
        rig.desktop.sessions.last?.close()
        #expect(rig.engine.status == .searching)
        #expect(await eventually { rig.connected && rig.network.opens == 2 })
    }

    @Test func goingToTheBackgroundStopsEverythingAndComingBackReconnects() async throws {
        let rig = try Rig()
        rig.engine.setForeground(true)
        #expect(await eventually { rig.connected })
        rig.engine.setForeground(false)
        #expect(rig.desktop.sessions.last?.closed == true)
        #expect(!rig.network.browsing)
        if case .offline("Test Mac", _) = rig.engine.status {} else { Issue.record("expected offline, got \(rig.engine.status)") }
        rig.engine.setForeground(true)
        #expect(await eventually { rig.connected && rig.network.opens == 2 })
    }

    @Test func aNetworkChangeTriesAgainAtOnce() async throws {
        var config = testConfig()
        config.retryFrom = .seconds(30)
        config.retryUpTo = .seconds(30)
        let rig = try Rig(config: config)
        rig.network.openError = .timeout
        rig.engine.setForeground(true)
        #expect(await eventually { rig.network.opens == 1 })
        rig.network.openError = nil
        rig.network.changePath()
        #expect(await eventually { rig.connected })
    }

    @Test func pairingKeepsTheKeysAndConnects() async throws {
        let rig = try Rig(paired: false)
        rig.engine.setForeground(true)
        rig.engine.lookForComputers(true)
        #expect(await eventually { !rig.engine.discovered.isEmpty })
        try await rig.engine.pair(with: rig.engine.discovered[0], code: "123456")
        let saved = try #require(rig.vault.load())
        #expect(saved.desktopId == "desk-1")
        #expect(saved.desktopKey == Data(repeating: 9, count: 32))
        #expect(try KeyPair(privateKey: saved.phonePrivateKey).publicKey == rig.network.pairCalls[0].phoneKey)
        #expect(rig.network.pairCalls[0].code == "123456")
        #expect(await eventually { rig.connected })
    }

    @Test func pairingAgainWithTheSameComputerKeepsEditsNotSentYet() async throws {
        let rig = try Rig { d in d.addMeeting("m1", title: "One"); d.addNotes("m1", mine: "desk") }
        rig.engine.setForeground(true)
        #expect(await eventually { rig.connected && rig.store.meetings().count == 1 })
        rig.engine.setForeground(false)
        try rig.store.editMine(meetingId: "m1", text: "typed offline")
        rig.engine.setForeground(true)
        rig.engine.lookForComputers(true)
        #expect(await eventually { !rig.engine.discovered.isEmpty })
        rig.desktop.opReply = { _ in .failure(.remote("busy")) }
        try await rig.engine.pair(with: rig.engine.discovered[0], code: "123456")
        #expect(rig.store.pendingOps().map(\.op.text) == ["typed offline"])
        #expect(rig.store.notes("m1")?.mine == "typed offline")
    }

    @Test func aWrongCodeLeavesItUnpaired() async throws {
        let rig = try Rig(paired: false)
        rig.network.pairResult = .failure(.wrongCode)
        rig.engine.setForeground(true)
        rig.engine.lookForComputers(true)
        #expect(await eventually { !rig.engine.discovered.isEmpty })
        await #expect(throws: PairingError.wrongCode) { try await rig.engine.pair(with: rig.engine.discovered[0], code: "000000") }
        #expect(rig.vault.load() == nil)
        #expect(rig.engine.status == .notPaired)
    }

    @Test func unpairWipesTheKeysAndTheCopy() async throws {
        let rig = try Rig { d in d.addMeeting("m1", title: "One"); d.audioFiles["m1"] = Data("made-up audio".utf8) }
        rig.engine.setForeground(true)
        #expect(await eventually { rig.connected && rig.store.meetings().count == 1 })
        let audio = try await rig.engine.audioURL(meetingId: "m1")
        #expect(FileManager.default.fileExists(atPath: audio.path))
        rig.engine.unpair()
        // the computer's recordings don't stay on the phone either
        #expect(!FileManager.default.fileExists(atPath: audio.path))
        #expect(rig.engine.status == .notPaired)
        #expect(rig.vault.load() == nil)
        #expect(rig.store.meetings().isEmpty)
        #expect(rig.desktop.sessions.last?.closed == true)
    }

    @Test func aRoundThatFailsNeverSaysSyncedJustNowAndTriesAgain() async throws {
        let rig = try Rig { d in d.addMeeting("m1", title: "One"); d.pullError = .remote("failed") }
        rig.engine.setForeground(true)
        #expect(await eventually { if case .error = rig.engine.status { true } else { false } })
        #expect(!rig.engine.status.label.contains("Synced just now"))
        #expect(rig.engine.lastSync == nil)
        rig.desktop.pullError = nil
        #expect(await eventually { rig.connected && rig.store.meetings().count == 1 })
        #expect(rig.engine.lastSync != nil)
    }

    @Test func aDeniedLocalNetworkSaysHowToAllowIt() async throws {
        let rig = try Rig()
        rig.network.shown = []
        rig.engine.setForeground(true)
        rig.network.denyLocalNetwork(true)
        #expect(rig.engine.status == .error("Allow Local Network for Yogurt in Settings to reach your computer."))
        #expect(rig.engine.localNetworkDenied)
        // it doesn't turn into "Not on the same Wi-Fi" later
        try await Task.sleep(for: .milliseconds(400))
        #expect(rig.engine.status == .error(SyncEngine.localNetwork))
        rig.network.denyLocalNetwork(false)
        #expect(!rig.engine.localNetworkDenied)
        rig.network.show(FakeNetwork(rig.desktop).shown)
        #expect(await eventually { rig.connected })
    }

    @Test func aConnectionRefusedByThePermissionSaysSoToo() async throws {
        let rig = try Rig()
        rig.network.openError = .localNetworkDenied
        rig.engine.setForeground(true)
        #expect(await eventually { rig.engine.status == .error(SyncEngine.localNetwork) })
    }

    @Test func unpairedTheDeniedPermissionIsShownWithoutLeavingNotPaired() async throws {
        let rig = try Rig(paired: false)
        rig.engine.setForeground(true)
        rig.network.denyLocalNetwork(true)
        #expect(rig.engine.status == .notPaired)
        #expect(rig.engine.localNetworkDenied)
    }

    @Test func anUploadIsDoneOnlyOnceTheDesktopSaysImported() async throws {
        let rig = try Rig()
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("p1-\(UUID().uuidString).m4a")
        try Data([1, 2, 3]).write(to: url)
        rig.desktop.uploadAudioReply = { body in ["received": body["index"] as? Int ?? 0, "done": true] }
        let rec = LocalRecording(id: "p1", title: "Walk", startedAt: Date(timeIntervalSince1970: 10), endedAt: Date(timeIntervalSince1970: 20),
                                 attendees: [], audioURL: url, myNotes: "", transcript: [], summary: nil)
        try rig.store.saveLocalRecording(rec)
        rig.engine.setForeground(true)
        #expect(await eventually { !rig.desktop.requests("uploadAudio").isEmpty })
        try await Task.sleep(for: .milliseconds(50))
        #expect(rig.store.localRecordings().first?.uploadedAt == nil)
    }

    @Test func aRecordingStillGoingIsNotUploaded() async throws {
        let rig = try Rig()
        let rec = LocalRecording(id: "p1", title: "Walk", startedAt: Date(timeIntervalSince1970: 10), endedAt: nil, attendees: [],
                                 audioURL: URL(fileURLWithPath: "/nonexistent/p1.m4a"), myNotes: "", transcript: [], summary: nil)
        try rig.store.saveLocalRecording(rec)
        rig.engine.setForeground(true)
        #expect(await eventually { rig.connected })
        #expect(rig.desktop.requests("uploadMeeting").isEmpty)
    }
}
