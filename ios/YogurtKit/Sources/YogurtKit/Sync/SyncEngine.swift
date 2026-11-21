import Foundation
import Network
import os

/// How the engine reaches the desktop. `LiveNetwork` is Bonjour + TCP; tests hand in a stand-in desktop.
@MainActor
public protocol SyncNetwork: AnyObject {
    func browse(_ update: @escaping @MainActor ([FoundDesktop]) -> Void)
    func stopBrowsing()
    /// called when the phone joins or switches networks
    func watchPath(_ changed: @escaping @MainActor () -> Void)
    func pair(_ at: FoundDesktop, code: String, phoneName: String, phoneKey: Data, phoneId: String) async throws -> PairedDesktop
    /// handshake and hello; throws `SyncError.unrecognised` when the desktop refuses this phone's key
    func open(_ at: FoundDesktop, phone: KeyPair, desktopKey: Data, appVersion: String) async throws -> DesktopSession
}

@MainActor
public final class LiveNetwork: SyncNetwork {
    private let browser: DesktopBrowser
    private var path: PathWatcher?

    public init(browser: DesktopBrowser = BonjourBrowser()) { self.browser = browser }

    public func browse(_ update: @escaping @MainActor ([FoundDesktop]) -> Void) { browser.start(update) }
    public func stopBrowsing() { browser.stop() }

    public func watchPath(_ changed: @escaping @MainActor () -> Void) {
        let p = PathWatcher()
        p.start(changed)
        path = p
    }

    public func pair(_ at: FoundDesktop, code: String, phoneName: String, phoneKey: Data, phoneId: String) async throws -> PairedDesktop {
        // busy: another phone is mid-exchange, or a wrong guess was just made; the desktop asks for a second's pause
        for attempt in 0..<4 {
            let t: NWTransport
            do { t = try await NWTransport.connect(to: at.endpoint) } catch { throw PairingError.unreachable }
            defer { t.close() }
            do {
                return try await pairExchange(t, code: code, phoneName: phoneName, phoneKey: phoneKey, phoneId: phoneId)
            } catch SyncError.remote("busy") where attempt < 3 {
                try await Task.sleep(for: .milliseconds(1200))
            } catch let e as PairingError {
                throw e
            } catch {
                throw PairingError.unreachable
            }
        }
        throw PairingError.unreachable
    }

    public func open(_ at: FoundDesktop, phone: KeyPair, desktopKey: Data, appVersion: String) async throws -> DesktopSession {
        let t = try await NWTransport.connect(to: at.endpoint)
        do { return try await NoiseSession.open(t, phone: phone, desktopKey: desktopKey, appVersion: appVersion) } catch {
            t.close()
            throw error
        }
    }
}

public struct SyncConfig: Sendable {
    public var appVersion = "0"
    public var phoneName = "iPhone"
    /// paired but no session for this long: the computer counts as not reachable
    public var offlineAfter: Duration = .seconds(10)
    /// before the first browse while not paired, so the pairing screen (which explains the permission) is up first
    public var firstBrowseDelay: Duration = .milliseconds(1500)
    public var retryFrom: Duration = .seconds(1)
    public var retryUpTo: Duration = .seconds(30)
    /// the desktop closes a session it hasn't heard from in 2 minutes
    public var keepalive: Duration = .seconds(30)
    public var pullLimit = 200
    /// raw bytes per uploadAudio: base64 of 44000 bytes keeps each message under the 60000-byte chunking limit
    public var audioChunk = 44000
    public var audioFolder = URL.cachesDirectory.appending(path: "Yogurt audio", directoryHint: .isDirectory)
    public init() {}
}

/// The phone's side of sync. On the main actor beside the Store, which it fills from `pull`, and the status the
/// pill shows, which only ever says what is true right now.
@MainActor @Observable
public final class SyncEngine: SyncEngineProtocol {
    public static let unrecognised = "This computer doesn't recognise this iPhone any more. Pair again."

    public private(set) var status: ConnectionStatus
    public private(set) var discovered: [DiscoveredDesktop] = []
    public private(set) var revision = 0

    @ObservationIgnored private let store: Store
    @ObservationIgnored private let vault: PairingVault
    @ObservationIgnored private let network: SyncNetwork
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let config: SyncConfig
    @ObservationIgnored private let log = Logger(subsystem: "chat.yogurt", category: "sync")

    @ObservationIgnored private var pairing: Pairing?
    @ObservationIgnored private var found: [FoundDesktop] = []
    @ObservationIgnored private var session: DesktopSession?
    @ObservationIgnored private var active = false
    @ObservationIgnored private var browsing: Task<Void, Never>?
    @ObservationIgnored private var connecting: Task<Void, Never>?
    @ObservationIgnored private var retry: Task<Void, Never>?
    @ObservationIgnored private var offlineTimer: Task<Void, Never>?
    @ObservationIgnored private var keepalive: Task<Void, Never>?
    @ObservationIgnored private var sync: Task<Void, Never>?
    @ObservationIgnored private var syncAgain = false
    @ObservationIgnored private var backoff: Duration
    /// handshakes refused in a row; one could be a dropped connection, two means the desktop doesn't know this key
    @ObservationIgnored private var refusals = 0
    /// pull everything again from 0: the desktop's copy may differ from what is here without a change to tell us
    @ObservationIgnored private var fullPull = false

    private static let lastSyncKey = "yogurt.sync.lastSync"
    var lastSync: Date? {
        get { (defaults.object(forKey: Self.lastSyncKey) as? Double).map { Date(timeIntervalSince1970: $0) } }
        set { defaults.set(newValue?.timeIntervalSince1970, forKey: Self.lastSyncKey) }
    }

    public init(store: Store, vault: PairingVault, network: SyncNetwork, defaults: UserDefaults = .standard, config: SyncConfig = SyncConfig()) {
        self.store = store; self.vault = vault; self.network = network; self.defaults = defaults; self.config = config
        backoff = config.retryFrom
        pairing = vault.load()
        status = .notPaired
        if let pairing { status = .offline(pairing.desktopName, lastSync: lastSync) }
        network.watchPath { [weak self] in self?.networkChanged() }
    }

    // MARK: - Foreground and background

    /// The app came to the front (true) or went to the background (false). Nothing runs in the background.
    public func setForeground(_ on: Bool) {
        if on { start() } else { stop() }
    }

    func start() {
        guard !active else { return }
        active = true
        backoff = config.retryFrom
        refusals = 0
        if pairing != nil { lookFor() }
        let delay = pairing == nil ? config.firstBrowseDelay : .zero
        browsing = Task { [weak self] in
            if delay > .zero { try? await Task.sleep(for: delay) }
            guard let self, !Task.isCancelled, self.active else { return }
            self.network.browse { [weak self] in self?.foundChanged($0) }
        }
    }

    func stop() {
        guard active else { return }
        active = false
        browsing?.cancel()
        network.stopBrowsing()
        found = []
        discovered = []
        cancelTimers()
        endSession()
        if let pairing, !isError { status = .offline(pairing.desktopName, lastSync: lastSync) }
    }

    private var isError: Bool { if case .error = status { true } else { false } }

    private func cancelTimers() {
        for t in [connecting, retry, offlineTimer, keepalive] { t?.cancel() }
        connecting = nil; retry = nil; offlineTimer = nil; keepalive = nil
    }

    private func endSession() {
        let s = session
        session = nil
        keepalive?.cancel()
        s?.close()
    }

    /// Joined or switched networks: a phone without its computer tries again now rather than at its next backoff.
    private func networkChanged() {
        guard active, pairing != nil, session == nil else { return }
        retry?.cancel(); retry = nil
        backoff = config.retryFrom
        refusals = 0
        if isError { lookFor() } else { connectIfPossible() }
        network.stopBrowsing()
        network.browse { [weak self] in self?.foundChanged($0) }
    }

    // MARK: - Finding and connecting

    private func foundChanged(_ list: [FoundDesktop]) {
        let before = Set(found.map(\.desktop.id))
        found = list
        discovered = list.map(\.desktop)
        guard let pairing, session == nil else { return }
        // the computer just showed up: no reason to wait out the backoff
        if !before.contains(pairing.desktopId), list.contains(where: { $0.desktop.id == pairing.desktopId }) {
            retry?.cancel(); retry = nil
            backoff = config.retryFrom
        }
        connectIfPossible()
    }

    /// Paired, no session: looking, and offline if nothing works out within `offlineAfter`.
    private func lookFor() {
        status = .searching
        armOffline()
        connectIfPossible()
    }

    private func armOffline() {
        offlineTimer?.cancel()
        offlineTimer = Task { [weak self, config] in
            try? await Task.sleep(for: config.offlineAfter)
            guard let self, !Task.isCancelled, self.session == nil, let p = self.pairing, !self.isError else { return }
            self.status = .offline(p.desktopName, lastSync: self.lastSync)
        }
    }

    private func connectIfPossible() {
        guard active, let pairing, session == nil, connecting == nil, retry == nil, !isError,
              let target = found.first(where: { $0.desktop.id == pairing.desktopId }) else { return }
        // once it has said offline it stays so until a session is up, so retries don't flicker the pill
        if case .offline = status {} else { status = .connecting(pairing.desktopName) }
        connecting = Task { [weak self] in await self?.connect(target, pairing) }
    }

    private func connect(_ target: FoundDesktop, _ pairing: Pairing) async {
        do {
            let s = try await network.open(target, phone: try KeyPair(privateKey: pairing.phonePrivateKey), desktopKey: pairing.desktopKey,
                                           appVersion: config.appVersion)
            connecting = nil
            guard active, self.pairing == pairing, session == nil else { s.close(); return }
            opened(s)
        } catch {
            connecting = nil
            guard active, self.pairing == pairing, !Task.isCancelled else { return }
            log.notice("connect failed: \(String(describing: error), privacy: .public)")
            if error as? SyncError == .unrecognised {
                refusals += 1
                if refusals >= 2 {
                    offlineTimer?.cancel()
                    status = .error(Self.unrecognised)
                    return
                }
            }
            scheduleRetry()
        }
    }

    private func scheduleRetry() {
        let wait = backoff
        backoff = min(backoff * 2, config.retryUpTo)
        retry = Task { [weak self] in
            try? await Task.sleep(for: wait)
            guard let self, !Task.isCancelled else { return }
            self.retry = nil
            self.connectIfPossible()
        }
    }

    private func opened(_ s: DesktopSession) {
        session = s
        refusals = 0
        backoff = config.retryFrom
        offlineTimer?.cancel()
        if var p = pairing, !s.hello.desktopName.isEmpty, s.hello.desktopName != p.desktopName {
            p.desktopName = s.hello.desktopName
            try? vault.save(p)
            pairing = p
        }
        // this computer's database was replaced or started afresh: what is here came from another log
        if let epoch = s.hello.epoch, let mine = store.epoch, epoch != mine {
            try? store.resetForNewEpoch()
            revision += 1
        }
        // "Synced just now" only once the first round has caught up
        status = .connected(name, syncing: 0)
        s.onChanged = { [weak self] in self?.requestSync() }
        s.onClose = { [weak self, weak s] in self?.ended(s) }
        keepalive = Task { [weak self, weak s, config] in
            while !Task.isCancelled {
                try? await Task.sleep(for: config.keepalive)
                guard !Task.isCancelled, let s else { return }
                // no pong: the connection is dead even if TCP hasn't noticed
                do { _ = try await s.request("ping", [:], timeout: .seconds(10)) } catch { s.close(); return }
                _ = self
            }
        }
        requestSync()
    }

    private func ended(_ s: DesktopSession?) {
        guard let s, session === s else { return }
        session = nil
        keepalive?.cancel()
        guard active, pairing != nil else { return }
        status = .searching
        armOffline()
        scheduleRetry()
    }

    private var name: String { pairing?.desktopName ?? "" }

    // MARK: - Pairing

    public func pair(with desktop: DiscoveredDesktop, code: String) async throws {
        guard let target = found.first(where: { $0.desktop.id == desktop.id }) else { throw PairingError.unreachable }
        let keys = KeyPair.generate()
        let phoneId = UUID().uuidString
        let d = try await network.pair(target, code: code, phoneName: config.phoneName, phoneKey: keys.publicKey, phoneId: phoneId)
        let p = Pairing(phonePrivateKey: keys.privateKey, phoneId: phoneId, desktopId: d.id, desktopName: d.name, desktopKey: d.key)
        try vault.save(p)
        // whatever was here belonged to no computer, or another one
        try? store.forgetDesktop()
        lastSync = nil
        pairing = p
        revision += 1
        refusals = 0
        backoff = config.retryFrom
        if active { lookFor() } else { status = .offline(p.desktopName, lastSync: nil) }
    }

    public func unpair() {
        pairing = nil
        vault.delete()
        cancelTimers()
        endSession()
        try? store.forgetDesktop()
        lastSync = nil
        revision += 1
        status = .notPaired
    }

    // MARK: - Sync

    /// Sends what's waiting and pulls what's new; when not connected, tries to connect now.
    public func syncNow() async {
        if session == nil {
            guard active, pairing != nil else { return }
            retry?.cancel(); retry = nil
            backoff = config.retryFrom
            if isError { refusals = 0; lookFor() } else { connectIfPossible() }
            await connecting?.value
        } else {
            requestSync()
        }
        await sync?.value
    }

    private func requestSync() {
        guard let s = session else { return }
        if sync != nil { syncAgain = true; return }
        sync = Task { [weak self] in
            guard let self else { return }
            repeat {
                self.syncAgain = false
                await self.round(s)
            } while self.syncAgain && self.session === s
            self.sync = nil
        }
    }

    private func round(_ s: DesktopSession) async {
        do {
            try await pull(s, from: fullPull ? 0 : nil)
            fullPull = false
            var again = try await sendOps(s)
            again = try await sendUploads(s) || again
            if again || fullPull {
                try await pull(s, from: fullPull ? 0 : nil)
                fullPull = false
            }
            lastSync = Date()
        } catch {
            // a dropped session ends through onClose; anything else waits for the next round
            log.notice("sync round stopped: \(String(describing: error), privacy: .public)")
        }
        if session === s { status = .connected(name, syncing: nil) }
    }

    private func pull(_ s: DesktopSession, from: Int?) async throws {
        var since = from ?? store.cursor
        while true {
            let r = try await s.request("pull", ["since": since, "limit": config.pullLimit], timeout: .seconds(60))
            let epoch = r["epoch"] as? String
            if let epoch, let mine = store.epoch, epoch != mine {
                try store.resetForNewEpoch()
                revision += 1
                since = 0
                continue
            }
            guard let cursor = r["cursor"] as? Int else { throw SyncError.badMessage }
            let changes = try JSONDecoder().decode([Change].self, from: JSONSerialization.data(withJSONObject: r["changes"] ?? []))
            let more = r["more"] as? Bool ?? false
            if more, session === s {
                let meetings = Set(changes.filter { ["meeting", "notes", "segments"].contains($0.entity) }.map(\.id))
                status = .connected(name, syncing: meetings.count)
            }
            try store.apply(changes, cursor: cursor, epoch: epoch)
            revision += 1
            guard more else { return }
            since = cursor
        }
    }

    /// In order; each is cleared only once the desktop said ok. True when any was answered.
    private func sendOps(_ s: DesktopSession) async throws -> Bool {
        var answered = false
        // a meeting whose op has to wait keeps its later ops waiting too, so they arrive in order
        var held = Set<String>()
        for p in store.pendingOps() where !held.contains(p.op.meetingId) {
            let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(p.op)) as? [String: Any] ?? [:]
            do {
                let r = try await s.request("op", body, timeout: .seconds(30))
                let merged = r["merged"] as? Bool == true
                try store.markSent(p.id, merged: merged)
                // both sides had changed My notes: the desktop may not echo, so its text is fetched again
                if merged { fullPull = true }
            } catch SyncError.remote(let code) {
                if code == "busy" || code == "failed" || (code == "gone" && notUploaded(p.op.meetingId)) {
                    held.insert(p.op.meetingId)
                    continue
                }
                // refused for good: dropped, and (unless the meeting is gone) the desktop's copy replaces the phone's
                log.notice("op \(p.op.kind.rawValue, privacy: .public) refused: \(code, privacy: .public)")
                try store.markSent(p.id)
                if code != "gone" { fullPull = true }
            }
            answered = true
            revision += 1
        }
        return answered
    }

    private func notUploaded(_ meetingId: String) -> Bool {
        store.localRecordings().contains { $0.id == meetingId && $0.uploadedAt == nil }
    }

    // MARK: - Recordings

    /// Keeps a recording made here and sends it to the computer now or at the next sync. The phone keeps its copy
    /// until the desktop says it is in (imported).
    public func upload(_ rec: LocalRecording) async throws {
        try store.saveLocalRecording(rec)
        revision += 1
        await syncNow()
    }

    private func sendUploads(_ s: DesktopSession) async throws -> Bool {
        var any = false
        let waiting = store.localRecordings().filter { $0.uploadedAt == nil }
        for (i, rec) in waiting.enumerated() {
            if session === s { status = .connected(name, syncing: waiting.count - i) }
            do {
                if try await upload(rec, over: s) { any = true }
            } catch let e as SyncError where e == .closed || e == .timeout {
                throw e
            } catch {
                // busy, too big, failed or no audio: this one waits, the others go
                log.notice("upload \(rec.id, privacy: .public) waits: \(String(describing: error), privacy: .public)")
            }
        }
        return any
    }

    /// True once the desktop has the meeting for good.
    private func upload(_ rec: LocalRecording, over s: DesktopSession) async throws -> Bool {
        let ms = { (d: Date) in Int((d.timeIntervalSince1970 * 1000).rounded()) }
        let meeting: [String: Any] = [
            "id": rec.id, "title": rec.title, "startedAt": ms(rec.startedAt), "endedAt": ms(rec.endedAt ?? rec.startedAt),
            "attendees": rec.attendees.map { ["name": $0.name ?? "", "email": $0.email as Any? ?? NSNull()] },
        ]
        var body: [String: Any] = ["meeting": meeting, "myNotes": rec.myNotes,
                                   "transcript": rec.transcript.map { ["startMs": $0.startMs, "endMs": $0.endMs, "text": $0.text] }]
        if let summary = rec.summary { body["summary"] = summary }
        // order: the desktop lost track of the chunks; gone: it dropped the staged upload. Either way start over, once.
        for attempt in 0..<2 {
            let r = try await s.request("uploadMeeting", body, timeout: .seconds(120))
            if r["imported"] as? Bool != true {
                do { try await sendAudio(rec, over: s) } catch SyncError.remote(let code) where attempt == 0 && (code == "order" || code == "gone") {
                    continue
                }
            }
            try store.markUploaded(rec.id)
            revision += 1
            return true
        }
        return false
    }

    private func sendAudio(_ rec: LocalRecording, over s: DesktopSession) async throws {
        let file = try FileHandle(forReadingFrom: rec.audioURL)
        defer { try? file.close() }
        let size = (try FileManager.default.attributesOfItem(atPath: rec.audioURL.path)[.size] as? Int) ?? 0
        let of = max(1, (size + config.audioChunk - 1) / config.audioChunk)
        for index in 0..<of {
            let chunk = try file.read(upToCount: config.audioChunk) ?? Data()
            let r = try await s.request("uploadAudio", ["meetingId": rec.id, "chunk": chunk.base64EncodedString(), "index": index, "of": of, "mime": "audio/mp4"],
                                        // the last one waits for the import
                                        timeout: index == of - 1 ? .seconds(300) : .seconds(30))
            if r["done"] as? Bool == true { return }
        }
        throw SyncError.badMessage
    }

    // MARK: - Ask and audio

    public func ask(_ question: String, scope: AskScope?) async throws -> RemoteAnswer {
        guard let s = session else { throw SyncError.notConnected }
        var body: [String: Any] = ["question": question]
        if let scope { body["scope"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(scope)) }
        let r = try await s.request("ask", body, timeout: .seconds(300))
        return try JSONDecoder().decode(RemoteAnswer.self, from: JSONSerialization.data(withJSONObject: r))
    }

    /// One track of a desktop meeting's audio ("me" is the mic, "them" the call; a phone recording is "them"),
    /// fetched once into the caches folder.
    public func audioURL(meetingId: String, track: String = "them") async throws -> URL {
        let file = config.audioFolder.appending(path: "\(meetingId)-\(track).m4a")
        if FileManager.default.fileExists(atPath: file.path) { return file }
        guard let s = session else { throw SyncError.notConnected }
        try FileManager.default.createDirectory(at: config.audioFolder, withIntermediateDirectories: true)
        let part = file.appendingPathExtension("part")
        FileManager.default.createFile(atPath: part.path, contents: nil)
        let out = try FileHandle(forWritingTo: part)
        do {
            try await s.stream("audio", ["meetingId": meetingId, "track": track], timeout: .seconds(30)) { body in
                guard let chunk = (body["chunk"] as? String).flatMap({ Data(base64Encoded: $0) }), let index = body["index"] as? Int,
                      let of = body["of"] as? Int else { throw SyncError.badMessage }
                try out.write(contentsOf: chunk)
                return index >= of - 1
            }
            try out.close()
            try FileManager.default.moveItem(at: part, to: file)
            return file
        } catch {
            try? out.close()
            try? FileManager.default.removeItem(at: part)
            throw error
        }
    }
}
