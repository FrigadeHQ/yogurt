import Foundation
import Network
@testable import YogurtKit

/// A stand-in for the desktop's companion server, at the level of app messages: a change log served by `pull`, ops,
/// uploads (staged audio is dropped when a session ends, as on the desktop), ask and audio. Made-up data only.
@MainActor final class FakeDesktop {
    let id = "desk-1"
    var name = "Test Mac"
    var epoch = "epoch-1"
    /// the change log; a change's seq is its index + 1
    var log: [[String: Any]] = []
    var requests: [(type: String, body: [String: Any])] = []
    var opReply: ([String: Any]) -> Result<[String: Any], SyncError> = { _ in .success(["applied": true]) }
    /// close the session instead of answering this request
    var dropWhen: (String, [String: Any]) -> Bool = { _, _ in false }
    /// awaited before answering, to hold a request open
    var hold: (@MainActor (String, [String: Any]) async -> Void)?
    var imported: [String: Int] = [:]
    var importedAudio: [String: Data] = [:]
    var staged: [String: (data: Data, next: Int)] = [:]
    var audioFiles: [String: Data] = [:]
    /// the kind of file the computer serves ("ext" on the first chunk); left out for an older computer
    var audioExt: [String: String] = [:]
    var sessions: [FakeSession] = []
    /// every pull is refused with this, while set
    var pullError: SyncError?
    /// answers uploadAudio instead of the usual staging, while set
    var uploadAudioReply: (([String: Any]) -> [String: Any])?

    func requests(_ type: String) -> [[String: Any]] { requests.filter { $0.type == type }.map(\.body) }

    func addMeeting(_ id: String, title: String, startedAt: Int = 1000, trashedAt: Int? = nil) {
        log.append(["entity": "meeting", "id": id, "record": ["id": id, "title": title, "startedAt": startedAt, "endedAt": startedAt + 1000,
                                                             "attendees": [], "app": NSNull(), "trashedAt": trashedAt as Any? ?? NSNull(), "language": NSNull()]])
    }

    func addNotes(_ id: String, mine: String) {
        log.append(["entity": "notes", "id": id, "record": ["meetingId": id, "mine": mine, "summary": NSNull(), "mineHash": notesHash(mine)]])
    }

    func answer(_ s: FakeSession, _ type: String, _ body: [String: Any]) throws -> [String: Any] {
        switch type {
        case "ping": return [:]
        case "pull":
            if let pullError { throw pullError }
            let since = body["since"] as? Int ?? 0, limit = body["limit"] as? Int ?? 200
            let page = Array(log.dropFirst(since).prefix(limit))
            let cursor = since + page.count
            return ["changes": page, "cursor": cursor, "more": cursor < log.count, "epoch": epoch]
        case "op":
            return try opReply(body).get()
        case "uploadMeeting":
            let id = (body["meeting"] as? [String: Any])?["id"] as? String ?? ""
            if imported[id] != nil { return ["accepted": true, "imported": true] }
            staged[id] = (Data(), 0)
            return ["accepted": true]
        case "uploadAudio":
            if let uploadAudioReply { return uploadAudioReply(body) }
            let id = body["meetingId"] as? String ?? "", index = body["index"] as? Int ?? -1, of = body["of"] as? Int ?? 0
            let chunk = Data(base64Encoded: body["chunk"] as? String ?? "") ?? Data()
            guard var u = staged[id] else { throw SyncError.remote("gone") }
            if index == 0 { u = (Data(), 0) } else if index != u.next { throw SyncError.remote("order") }
            u.data += chunk
            u.next = index + 1
            staged[id] = u
            guard u.next == of else { return ["received": index] }
            staged[id] = nil
            imported[id, default: 0] += 1
            importedAudio[id] = u.data
            log.append(["entity": "meeting", "id": id, "record": ["id": id, "title": "Imported", "startedAt": 1, "attendees": []]])
            return ["received": index, "done": true, "imported": true]
        case "ask":
            return ["answer": "Made-up answer to: \(body["question"] as? String ?? "")",
                    "sources": [["meetingId": "m1", "title": "Banana sync", "atMs": 1200, "text": "we chose bananas"]]]
        default:
            throw SyncError.remote("unknown-type")
        }
    }
}

@MainActor final class FakeSession: DesktopSession {
    let desktop: FakeDesktop
    let hello: DesktopHello
    var onChanged: (@MainActor () -> Void)?
    var onClose: (@MainActor () -> Void)?
    private(set) var closed = false

    init(_ desktop: FakeDesktop) {
        self.desktop = desktop
        hello = DesktopHello(desktopId: desktop.id, desktopName: desktop.name, epoch: desktop.epoch)
    }

    func request(_ type: String, _ body: [String: Any], timeout: Duration) async throws -> [String: Any] {
        guard !closed else { throw SyncError.closed }
        desktop.requests.append((type, body))
        await desktop.hold?(type, body)
        guard !closed else { throw SyncError.closed }
        if desktop.dropWhen(type, body) { close(); throw SyncError.closed }
        return try desktop.answer(self, type, body)
    }

    func stream(_ type: String, _ body: [String: Any], timeout: Duration, _ each: @escaping @MainActor ([String: Any]) throws -> Bool) async throws {
        guard !closed else { throw SyncError.closed }
        desktop.requests.append((type, body))
        guard let data = desktop.audioFiles[body["meetingId"] as? String ?? ""] else { throw SyncError.remote("gone") }
        let parts = stride(from: 0, to: max(data.count, 1), by: 4).map { data.subdata(in: $0..<min($0 + 4, data.count)) }
        for (i, p) in parts.enumerated() {
            var chunk: [String: Any] = ["chunk": p.base64EncodedString(), "index": i, "of": parts.count]
            if i == 0, let ext = desktop.audioExt[body["meetingId"] as? String ?? ""] { chunk["ext"] = ext }
            if try each(chunk) { return }
        }
    }

    func close() {
        guard !closed else { return }
        closed = true
        // as on the desktop: audio half received is dropped when the connection goes
        desktop.staged.removeAll()
        onClose?()
    }
}

@MainActor final class FakeNetwork: SyncNetwork {
    let desktop: FakeDesktop
    var shown: [FoundDesktop]
    private var update: (@MainActor ([FoundDesktop]) -> Void)?
    private var pathChanged: (@MainActor () -> Void)?
    var openError: SyncError?
    var holdOpen: (@MainActor () async -> Void)?
    var opens = 0
    var pairResult: Result<PairedDesktop, PairingError>
    var pairCalls: [(code: String, phoneKey: Data, phoneId: String)] = []

    init(_ desktop: FakeDesktop) {
        self.desktop = desktop
        shown = [FoundDesktop(desktop: DiscoveredDesktop(id: desktop.id, name: desktop.name, pairing: false), endpoint: .hostPort(host: "127.0.0.1", port: 1))]
        pairResult = .success(PairedDesktop(id: desktop.id, name: desktop.name, key: Data(repeating: 9, count: 32)))
    }

    var browsing: Bool { update != nil }
    func browse(_ update: @escaping @MainActor ([FoundDesktop]) -> Void) { self.update = update; update(shown) }
    func stopBrowsing() { update = nil }
    var isBrowsing: Bool { update != nil }
    func show(_ list: [FoundDesktop]) { shown = list; update?(list) }
    func watchPath(_ changed: @escaping @MainActor () -> Void) { pathChanged = changed }
    private var localNetwork: (@MainActor (Bool) -> Void)?
    func watchLocalNetwork(_ denied: @escaping @MainActor (Bool) -> Void) { localNetwork = denied }
    /// what iOS says when the person tapped Don't Allow (true) or turned it on in Settings (false)
    func denyLocalNetwork(_ denied: Bool) { localNetwork?(denied) }
    func changePath() { pathChanged?() }

    func pair(_ at: FoundDesktop, code: String, phoneName: String, phoneKey: Data, phoneId: String) async throws -> PairedDesktop {
        pairCalls.append((code, phoneKey, phoneId))
        return try pairResult.get()
    }

    func open(_ at: FoundDesktop, phone: KeyPair, desktopKey: Data, appVersion: String) async throws -> DesktopSession {
        opens += 1
        await holdOpen?()
        if let openError { throw openError }
        let s = FakeSession(desktop)
        desktop.sessions.append(s)
        return s
    }
}

/// A gate a test opens when it's ready.
@MainActor final class Gate {
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private(set) var isOpen = false
    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func open() { isOpen = true; for w in waiters { w.resume() }; waiters = [] }
}

@MainActor func eventually(within: Duration = .seconds(3), _ condition: () -> Bool) async -> Bool {
    let end = ContinuousClock.now + within
    while ContinuousClock.now < end {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return condition()
}

func testConfig() -> SyncConfig {
    var c = SyncConfig()
    c.offlineAfter = .milliseconds(300)
    c.firstBrowseDelay = .zero
    c.retryFrom = .milliseconds(10)
    c.retryUpTo = .milliseconds(40)
    c.keepalive = .seconds(60)
    c.pullLimit = 2
    c.audioChunk = 10
    c.audioFolder = FileManager.default.temporaryDirectory.appendingPathComponent("yogurt-audio-\(UUID().uuidString)")
    c.uploadFolder = FileManager.default.temporaryDirectory.appendingPathComponent("yogurt-uploads-\(UUID().uuidString)")
    c.uploadRetryFrom = .milliseconds(150)
    c.uploadRetryUpTo = .milliseconds(600)
    return c
}

func testPairing(_ desktop: String = "desk-1") -> Pairing {
    Pairing(phonePrivateKey: KeyPair.generate().privateKey, phoneId: "phone-1", desktopId: desktop, desktopName: "Test Mac", desktopKey: Data(repeating: 9, count: 32))
}

@MainActor struct Rig {
    let desktop = FakeDesktop()
    let network: FakeNetwork
    let store: Store
    let vault: MemoryVault
    let defaults = UserDefaults(suiteName: "yogurt-tests-\(UUID().uuidString)")!
    let engine: SyncEngine

    init(paired: Bool = true, config: SyncConfig = testConfig(), seed: (FakeDesktop) -> Void = { _ in }) throws {
        seed(desktop)
        network = FakeNetwork(desktop)
        store = try Store(url: tempStoreURL())
        vault = MemoryVault(paired ? testPairing() : nil)
        engine = SyncEngine(store: store, vault: vault, network: network, defaults: defaults, config: config)
    }

    var connected: Bool { if case .connected(_, nil) = engine.status { true } else { false } }
}
