import Foundation
import Network
import Testing
@testable import YogurtKit

private func tempFolder(_ name: String = "yogurt-privacy") -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("\(name)-\(UUID().uuidString)", isDirectory: true)
}

private func age(_ url: URL, days: Double) throws {
    try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-days * 86400)], ofItemAtPath: url.path)
}

@Suite struct PrivateFolderTests {
    @Test func pruningRemovesWhatWasNotUsedForAWhileAndKeepsTheRest() throws {
        let url = tempFolder()
        defer { try? FileManager.default.removeItem(at: url) }
        try PrivateFolder.make(url)
        let old = url.appendingPathComponent("m1-them.m4a"), fresh = url.appendingPathComponent("m2-them.m4a")
        try Data("old".utf8).write(to: old)
        try Data("fresh".utf8).write(to: fresh)
        try age(old, days: 8)
        try age(fresh, days: 6)
        PrivateFolder.prune(url, unusedFor: 7 * 86400)
        #expect(!FileManager.default.fileExists(atPath: old.path))
        #expect(FileManager.default.fileExists(atPath: fresh.path))
        // a folder that isn't there is nothing to do
        PrivateFolder.prune(tempFolder(), unusedFor: 1)
    }
}

@MainActor @Suite struct CachedAudioTests {
    @Test func audioFetchedLongAgoAndNotPlayedSinceIsGoneAtLaunch() async throws {
        var config = testConfig()
        try PrivateFolder.make(config.audioFolder)
        let old = config.audioFolder.appendingPathComponent("m1-them.m4a"), fresh = config.audioFolder.appendingPathComponent("m2-them.m4a")
        try Data("old".utf8).write(to: old)
        try Data("fresh".utf8).write(to: fresh)
        try age(old, days: 8)
        try age(fresh, days: 1)
        config.keepAudioFor = 7 * 86400
        let rig = try Rig(config: config)
        #expect(!FileManager.default.fileExists(atPath: old.path))
        #expect(rig.engine.cachedAudio(meetingId: "m2") == fresh)
    }

    @Test func playingCachedAudioCountsAsUsingIt() async throws {
        let config = testConfig()
        try PrivateFolder.make(config.audioFolder)
        let file = config.audioFolder.appendingPathComponent("m1-them.m4a")
        try Data("audio".utf8).write(to: file)
        try age(file, days: 6)
        let rig = try Rig(config: config)
        #expect(rig.engine.cachedAudio(meetingId: "m1") == file)
        let used = try #require(try file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
        #expect(Date().timeIntervalSince(used) < 60)
    }
}

@Suite struct LeftoverPairingTests {
    @Test func aFreshInstallForgetsAPairingTheKeychainKeptFromBefore() {
        let defaults = UserDefaults(suiteName: "yogurt-tests-\(UUID().uuidString)")!
        let vault = MemoryVault(testPairing())
        LeftoverPairing.forget(defaults: defaults, vault: vault, protectedDataAvailable: true)
        #expect(vault.load() == nil)
    }

    @Test func anInstallThatWasSetUpKeepsItsPairing() {
        let defaults = UserDefaults(suiteName: "yogurt-tests-\(UUID().uuidString)")!
        defaults.set(true, forKey: "onboarded")
        let vault = MemoryVault(testPairing())
        LeftoverPairing.forget(defaults: defaults, vault: vault, protectedDataAvailable: true)
        #expect(vault.load() != nil)
    }

    @Test func beforeTheFirstUnlockNothingIsForgotten() {
        // the settings can't be read yet, so "not onboarded" can't be trusted
        let defaults = UserDefaults(suiteName: "yogurt-tests-\(UUID().uuidString)")!
        let vault = MemoryVault(testPairing())
        LeftoverPairing.forget(defaults: defaults, vault: vault, protectedDataAvailable: false)
        #expect(vault.load() != nil)
    }
}

@Suite struct DiscoveryTests {
    private let real = NWEndpoint.hostPort(host: "192.168.1.20", port: 7000)
    private let fake = NWEndpoint.hostPort(host: "192.168.1.66", port: 7000)

    @Test func everyAdvertForOneComputerIsKeptSoAFakeOneCanNotHideTheRealOne() {
        let found = BonjourBrowser.desktops([
            (["v": "1", "id": "desk-1", "pairing": "0"], fake),
            (["v": "1", "id": "desk-1", "pairing": "0"], real),
            (["v": "1", "id": "desk-2", "pairing": "1"], real),
            (["v": "2", "id": "desk-3"], real),
            (["v": "1", "id": ""], real),
        ])
        #expect(found.map(\.desktop.id).sorted() == ["desk-1", "desk-2"])
        let one = try! #require(found.first { $0.desktop.id == "desk-1" })
        #expect(one.endpoints == [fake, real])
    }

    @Test func theAdvertNamesNoComputer() {
        let found = BonjourBrowser.desktops([(["v": "1", "id": "desk-1", "pairing": "1", "name": "Someone's MacBook"], real)])
        // a name in an old advert is ignored too: the real one comes sealed in pairing
        #expect(found.first?.desktop.name == "")
        #expect(found.first?.desktop.pairing == true)
    }

    @Test func eachEndpointIsTriedAndARefusalCountsOnlyWhenAllRefused() async throws {
        // the fake refuses the key, the real one answers
        let r = try await eachEndpoint([1, 2], soft: { $0 as? SyncError == .unrecognised }) { n -> String in
            if n == 1 { throw SyncError.unrecognised }
            return "real"
        }
        #expect(r == "real")
        await #expect(throws: SyncError.unrecognised) {
            try await eachEndpoint([1, 2], soft: { $0 as? SyncError == .unrecognised }) { _ -> String in throw SyncError.unrecognised }
        }
        // one refused and one couldn't be reached: not a refusal, so it doesn't count towards "pair again"
        await #expect(throws: SyncError.timeout) {
            try await eachEndpoint([1, 2], soft: { $0 as? SyncError == .unrecognised }) { n -> String in
                throw n == 1 ? SyncError.unrecognised : SyncError.timeout
            }
        }
        // iOS refusing the local network stops at once: every endpoint would say the same
        var tried: [Int] = []
        await #expect(throws: SyncError.localNetworkDenied) {
            try await eachEndpoint([1, 2], soft: { _ in true }) { n -> String in tried.append(n); throw SyncError.localNetworkDenied }
        }
        #expect(tried == [1])
    }
}

@MainActor @Suite struct DiscoveredNameTests {
    @Test func thePairedComputerIsListedByTheNameItGaveWhenPairing() async throws {
        let rig = try Rig()
        rig.network.shown = [FoundDesktop(desktop: DiscoveredDesktop(id: "desk-1", name: "", pairing: false), endpoint: .hostPort(host: "127.0.0.1", port: 1)),
                             FoundDesktop(desktop: DiscoveredDesktop(id: "other", name: "", pairing: true), endpoint: .hostPort(host: "127.0.0.1", port: 2))]
        rig.engine.setForeground(true)
        #expect(await eventually { rig.engine.discovered.count == 2 })
        #expect(rig.engine.discovered.first { $0.id == "desk-1" }?.name == "Test Mac")
        #expect(rig.engine.discovered.first { $0.id == "other" }?.name == "")
    }
}
