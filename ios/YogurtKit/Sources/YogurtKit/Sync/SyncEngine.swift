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
    /// called with true when iOS refuses the local network (the person tapped Don't Allow), false once it works
    func watchLocalNetwork(_ denied: @escaping @MainActor (Bool) -> Void)
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

    public func watchLocalNetwork(_ denied: @escaping @MainActor (Bool) -> Void) {
        (browser as? BonjourBrowser)?.onDenied = denied
    }

    public func pair(_ at: FoundDesktop, code: String, phoneName: String, phoneKey: Data, phoneId: String) async throws -> PairedDesktop {
        // busy: another phone is mid-exchange, or a wrong guess was just made; the desktop asks for a second's pause
        for attempt in 0..<4 {
            let t: NWTransport
            do { t = try await NWTransport.connect(to: at.endpoint) } catch SyncError.localNetworkDenied { throw SyncError.localNetworkDenied } catch { throw PairingError.unreachable }
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
    /// a recording's WAV while it goes to the computer; emptied at launch
    public var uploadFolder = FileManager.default.temporaryDirectory.appending(path: "Yogurt uploads", directoryHint: .isDirectory)
    /// bytes free where the WAV is made (nil when iOS won't say)
    public var freeSpace: @Sendable () -> Int64? = {
        (try? FileManager.default.temporaryDirectory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?
            .volumeAvailableCapacityForImportantUsage
    }
    /// a recording the computer didn't take waits this long before it's sent again, doubling each time
    public var uploadRetryFrom: Duration = .seconds(30)
    public var uploadRetryUpTo: Duration = .seconds(600)
    public init() {}
}

/// The phone's side of sync. On the main actor beside the Store, which it fills from `pull`, and the status the
/// pill shows, which only ever says what is true right now.
@MainActor @Observable
public final class SyncEngine: SyncEngineProtocol {
    public static let unrecognised = "This computer doesn't recognise this iPhone any more. Pair again."
    public static let localNetwork = "Allow Local Network for Yogurt in Settings to reach your computer."
    public static let updateNeeded = "Update Yogurt on your iPhone or computer so they can sync again."
    static func syncFailed(_ name: String) -> String { "Couldn't sync with \(name) just now. Trying again soon." }
    static func uploadFailed(_ name: String) -> String { "Couldn't send a recording to \(name). Trying again soon." }

    public private(set) var status: ConnectionStatus
    public private(set) var discovered: [DiscoveredDesktop] = []
    public private(set) var revision = 0
    /// iOS refuses the local network for Yogurt: nothing can be found until it's allowed in Settings
    public private(set) var localNetworkDenied = false

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
    /// not paired, and the connect screen is open
    @ObservationIgnored private var looking = false
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
    /// the desktop refused this phone's key: no more tries until something changes
    @ObservationIgnored private var refused = false
    @ObservationIgnored private var roundRetry: Task<Void, Never>?
    @ObservationIgnored private var roundBackoff: Duration
    /// so a connect that was given up on can't clear the handle of the one after it
    @ObservationIgnored private var connectGeneration = 0
    /// pull everything again from 0: the desktop's copy may differ from what is here without a change to tell us
    @ObservationIgnored private var fullPull = false
    /// recordings the computer didn't take: how many tries so far, and not before when
    @ObservationIgnored private var uploadWaits: [String: (tries: Int, until: ContinuousClock.Instant)] = [:]
    @ObservationIgnored private var uploadRetry: Task<Void, Never>?
    var uploadFolder: URL { config.uploadFolder }
    /// a recording that waits a moment before going to the computer (its draft notes and title are being written)
    @ObservationIgnored public var holdsUpload: @MainActor (String) -> Bool = { _ in false }

    private static let lastSyncKey = "yogurt.sync.lastSync"
    var lastSync: Date? {
        get { (defaults.object(forKey: Self.lastSyncKey) as? Double).map { Date(timeIntervalSince1970: $0) } }
        set { defaults.set(newValue?.timeIntervalSince1970, forKey: Self.lastSyncKey) }
    }

    public init(store: Store, vault: PairingVault, network: SyncNetwork, defaults: UserDefaults = .standard, config: SyncConfig = SyncConfig()) {
        self.store = store; self.vault = vault; self.network = network; self.defaults = defaults; self.config = config
        backoff = config.retryFrom
        roundBackoff = config.retryFrom
        // WAVs a killed or crashed run left behind
        try? FileManager.default.removeItem(at: config.uploadFolder)
        pairing = vault.load()
        status = .notPaired
        if let pairing { status = .offline(pairing.desktopName, lastSync: lastSync) }
        network.watchPath { [weak self] in self?.networkChanged() }
        network.watchLocalNetwork { [weak self] in self?.localNetworkChanged($0) }
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
        refused = false
        // the Keychain may not have been readable at launch (before the first unlock)
        if pairing == nil, let p = vault.load() { pairing = p }
        if pairing != nil { lookFor(); startBrowsing(after: .zero) } else if looking { startBrowsing(after: config.firstBrowseDelay) }
    }

    /// Not paired: browse only while the connect screen is open, since browsing makes iOS ask for the local network.
    public func lookForComputers(_ on: Bool) {
        guard looking != on else { return }
        looking = on
        guard active, pairing == nil else { return }
        if on { startBrowsing(after: config.firstBrowseDelay) } else { stopBrowsing() }
    }

    private func startBrowsing(after delay: Duration) {
        browsing?.cancel()
        browsing = Task { [weak self] in
            if delay > .zero { try? await Task.sleep(for: delay) }
            guard let self, !Task.isCancelled, self.active else { return }
            self.network.browse { [weak self] in self?.foundChanged($0) }
        }
    }

    private func stopBrowsing() {
        browsing?.cancel()
        network.stopBrowsing()
        found = []
        discovered = []
    }

    func stop() {
        guard active else { return }
        active = false
        stopBrowsing()
        cancelTimers()
        endSession()
        if let pairing, !blocked { status = .offline(pairing.desktopName, lastSync: lastSync) }
    }

    /// a state no retry can get out of by itself
    private var blocked: Bool { refused || localNetworkDenied }

    private func localNetworkChanged(_ denied: Bool) {
        guard denied != localNetworkDenied else { return }
        localNetworkDenied = denied
        guard pairing != nil, active, session == nil else { return }
        if denied {
            cancelTimers()
            status = .error(Self.localNetwork)
        } else if status == .error(Self.localNetwork) {
            lookFor()
        }
    }

    private func cancelTimers() {
        for t in [connecting, retry, offlineTimer, keepalive, roundRetry] { t?.cancel() }
        connecting = nil; retry = nil; offlineTimer = nil; keepalive = nil; roundRetry = nil
    }

    private func endSession() {
        let s = session
        session = nil
        keepalive?.cancel()
        roundRetry?.cancel(); roundRetry = nil
        uploadRetry?.cancel(); uploadRetry = nil
        s?.close()
    }

    /// Joined or switched networks: a phone without its computer tries again now rather than at its next backoff.
    private func networkChanged() {
        guard active, pairing != nil, session == nil else { return }
        retry?.cancel(); retry = nil
        backoff = config.retryFrom
        refusals = 0
        if refused { refused = false; lookFor() } else { connectIfPossible() }
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
        if localNetworkDenied { status = .error(Self.localNetwork); return }
        status = .searching
        armOffline()
        connectIfPossible()
    }

    private func armOffline() {
        offlineTimer?.cancel()
        offlineTimer = Task { [weak self, config] in
            try? await Task.sleep(for: config.offlineAfter)
            guard let self, !Task.isCancelled, self.session == nil, let p = self.pairing, !self.blocked else { return }
            self.status = .offline(p.desktopName, lastSync: self.lastSync)
        }
    }

    private func connectIfPossible() {
        guard active, let pairing, session == nil, connecting == nil, retry == nil, !blocked,
              let target = found.first(where: { $0.desktop.id == pairing.desktopId }) else { return }
        // once it has said offline it stays so until a session is up, so retries don't flicker the pill
        if case .offline = status {} else { status = .connecting(pairing.desktopName) }
        connectGeneration += 1
        let generation = connectGeneration
        connecting = Task { [weak self] in await self?.connect(target, pairing, generation) }
    }

    private func connect(_ target: FoundDesktop, _ pairing: Pairing, _ generation: Int) async {
        do {
            let s = try await network.open(target, phone: try KeyPair(privateKey: pairing.phonePrivateKey), desktopKey: pairing.desktopKey,
                                           appVersion: config.appVersion)
            if generation == connectGeneration { connecting = nil }
            guard active, self.pairing == pairing, session == nil else { s.close(); return }
            opened(s)
        } catch {
            if generation == connectGeneration { connecting = nil }
            guard active, self.pairing == pairing, !Task.isCancelled, generation == connectGeneration else { return }
            if error as? SyncError == .localNetworkDenied {
                localNetworkChanged(true)
                return
            }
            log.notice("connect failed: \(String(describing: error), privacy: .public)")
            // the two speak different versions of sync: no retry helps until one is updated (tried again next time
            // Yogurt comes to the front)
            if error as? SyncError == .remote("schema") {
                refused = true
                offlineTimer?.cancel()
                status = .error(Self.updateNeeded)
                return
            }
            if error as? SyncError == .unrecognised {
                refusals += 1
                if refusals >= 2 {
                    refused = true
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
        if let p = pairing, !s.hello.desktopId.isEmpty, s.hello.desktopId != p.desktopId {
            log.notice("hello came from another desktop id")
        }
        if var p = pairing, !s.hello.desktopName.isEmpty, s.hello.desktopName != p.desktopName {
            p.desktopName = s.hello.desktopName
            try? vault.save(p)
            pairing = p
        }
        // this computer's database was replaced or started afresh: what is here came from another log
        if let epoch = s.hello.epoch, let mine = store.epoch, epoch != mine {
            try? store.resetForNewEpoch()
            dropAudio()
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
        endSession()
        let p = Pairing(phonePrivateKey: keys.privateKey, phoneId: phoneId, desktopId: d.id, desktopName: d.name, desktopKey: d.key)
        let same = pairing?.desktopId == d.id
        try vault.save(p)
        // whatever was here belonged to no computer, or another one. The same computer again (it lost this phone's
        // key): the copy and the edits not sent yet stay; a replaced database shows as a new epoch.
        if !same {
            try? store.forgetDesktop()
            dropAudio()
            lastSync = nil
        }
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
        dropAudio()
        lastSync = nil
        revision += 1
        status = .notPaired
        if !looking { stopBrowsing() }
    }

    // MARK: - Sync

    /// Sends what's waiting and pulls what's new; when not connected, tries to connect now.
    public func syncNow() async {
        if session == nil {
            guard active, pairing != nil else { return }
            retry?.cancel(); retry = nil
            backoff = config.retryFrom
            if refused { refused = false; refusals = 0; lookFor() } else { connectIfPossible() }
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
            // asked for by a session that came up while this one's loop was ending
            if self.syncAgain, self.session != nil, self.session !== s { self.requestSync() }
        }
    }

    private func round(_ s: DesktopSession) async {
        roundRetry?.cancel(); roundRetry = nil
        var ok = false
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
            ok = true
        } catch {
            // a dropped session ends through onClose; anything else is tried again with backoff
            log.notice("sync round stopped: \(String(describing: error), privacy: .public)")
        }
        guard session === s else { return }
        if ok {
            roundBackoff = config.retryFrom
            // a recording the computer didn't take: said so, and sent again after its wait
            if let next = uploadWaits.values.map(\.until).min() {
                status = .error(Self.uploadFailed(name))
                uploadRetry?.cancel()
                uploadRetry = Task { [weak self] in
                    try? await Task.sleep(until: next, clock: .continuous)
                    guard let self, !Task.isCancelled, self.session === s else { return }
                    self.requestSync()
                }
            } else {
                status = .connected(name, syncing: nil)
            }
            return
        }
        // never "Synced just now" after a round that didn't finish; lastSync keeps the last one that did
        status = .error(Self.syncFailed(name))
        let wait = roundBackoff
        roundBackoff = min(roundBackoff * 2, config.retryUpTo)
        roundRetry = Task { [weak self] in
            try? await Task.sleep(for: wait)
            guard let self, !Task.isCancelled, self.session === s else { return }
            self.requestSync()
        }
    }

    /// Still the same session with the same pairing after a wait, so a reply can be written to the Store.
    private func still(_ s: DesktopSession) throws {
        guard session === s, pairing != nil else { throw SyncError.closed }
    }

    /// The computer's audio fetched here goes with its meetings.
    private func dropAudio() { try? FileManager.default.removeItem(at: config.audioFolder) }

    private func pull(_ s: DesktopSession, from: Int?) async throws {
        var since = from ?? store.cursor
        while true {
            let r = try await s.request("pull", ["since": since, "limit": config.pullLimit], timeout: .seconds(60))
            try still(s)
            let epoch = r["epoch"] as? String
            if let epoch, let mine = store.epoch, epoch != mine {
                try store.resetForNewEpoch()
                dropAudio()
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
                try still(s)
                let merged = r["merged"] as? Bool == true
                try store.markSent(p.id, merged: merged)
                // both sides had changed My notes: the desktop may not echo, so its text is fetched again
                if merged { fullPull = true }
            } catch SyncError.remote(let code) {
                try still(s)
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
        // one still recording (no end yet) waits until it's finished
        let now = ContinuousClock.now
        let waiting = store.localRecordings().filter {
            $0.uploadedAt == nil && $0.endedAt != nil && !holdsUpload($0.id) && (uploadWaits[$0.id]?.until ?? now) <= now
        }
        for (i, rec) in waiting.enumerated() {
            if session === s { status = .connected(name, syncing: waiting.count - i) }
            do {
                if try await upload(rec, over: s) { any = true }
                uploadWaits[rec.id] = nil
            } catch let e as SyncError where e == .closed || e == .timeout {
                throw e
            } catch {
                // busy, too big, failed or no audio: this one waits a while, the others go
                let tries = (uploadWaits[rec.id]?.tries ?? 0) + 1
                let wait = min(config.uploadRetryFrom * Int(pow(2, Double(min(tries - 1, 10)))), config.uploadRetryUpTo)
                uploadWaits[rec.id] = (tries, ContinuousClock.now + wait)
                log.notice("upload \(rec.id, privacy: .public) waits: \(String(describing: error), privacy: .public)")
            }
        }
        // gone meanwhile (imported, discarded): nothing to wait for
        let open = Set(store.localRecordings().filter { $0.uploadedAt == nil }.map(\.id))
        uploadWaits = uploadWaits.filter { open.contains($0.key) }
        return any
    }

    /// True once the desktop has the meeting for good.
    private func upload(_ rec: LocalRecording, over s: DesktopSession) async throws -> Bool {
        let ms = { (d: Date) in Int((d.timeIntervalSince1970 * 1000).rounded()) }
        let meeting: [String: Any] = [
            "id": rec.id, "title": rec.title, "titleSource": rec.titleSource.rawValue, "startedAt": ms(rec.startedAt), "endedAt": ms(rec.endedAt ?? rec.startedAt),
            "attendees": rec.attendees.map { ["name": $0.name ?? "", "email": $0.email as Any? ?? NSNull()] },
        ]
        var body: [String: Any] = ["meeting": meeting, "myNotes": rec.myNotes,
                                   "transcript": rec.transcript.map { ["startMs": $0.startMs, "endMs": $0.endMs, "text": $0.text] }]
        if let summary = rec.summary { body["summary"] = summary }
        // order: the desktop lost track of the chunks; gone: it dropped the staged upload. Either way start over, once.
        for attempt in 0..<2 {
            let r = try await s.request("uploadMeeting", body, timeout: .seconds(120))
            try still(s)
            if r["imported"] as? Bool != true {
                do { try await sendAudio(rec, over: s); try still(s) } catch SyncError.remote(let code) where attempt == 0 && (code == "order" || code == "gone") {
                    continue
                }
            }
            try store.markUploaded(rec.id)
            try? FileManager.default.removeItem(at: wavURL(rec.id))
            revision += 1
            return true
        }
        return false
    }

    private func wavURL(_ id: String) -> URL { config.uploadFolder.appending(path: "\(id).wav") }

    /// The recording as WAV, made once and kept until the computer has it, so a retry doesn't convert it again.
    /// nil when it doesn't decode here, or there isn't room for it (32 kB a second, plus some to spare).
    private func wav(_ rec: LocalRecording) async -> URL? {
        let wav = wavURL(rec.id)
        if FileManager.default.fileExists(atPath: wav.path) { return wav }
        let seconds = max(0, (rec.endedAt ?? rec.startedAt).timeIntervalSince(rec.startedAt))
        if let free = config.freeSpace(), Double(free) < seconds * 32000 + 50_000_000 {
            log.notice("upload \(rec.id, privacy: .public): no room for the WAV")
            return nil
        }
        let source = rec.audioURL, part = wav.appendingPathExtension("part")
        // made off the main actor, under another name until it's whole
        let made = await Task.detached(priority: .utility) { () -> Bool in
            try? FileManager.default.createDirectory(at: wav.deletingLastPathComponent(), withIntermediateDirectories: true)
            do {
                try PhoneAudio.wav(from: source, to: part)
                try FileManager.default.moveItem(at: part, to: wav)
                return true
            } catch {
                try? FileManager.default.removeItem(at: part)
                return false
            }
        }.value
        return made ? wav : nil
    }

    private func sendAudio(_ rec: LocalRecording, over s: DesktopSession) async throws {
        // every computer can transcribe WAV; an m4a only a Mac can. Audio that doesn't decode here (or has no room to
        // be converted) goes as it is: a Mac may still read it.
        let wav = await wav(rec)
        try still(s)
        let (url, mime) = wav.map { ($0, "audio/wav") } ?? (rec.audioURL, "audio/mp4")
        let file = try FileHandle(forReadingFrom: url)
        defer { try? file.close() }
        let size = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        let of = max(1, (size + config.audioChunk - 1) / config.audioChunk)
        for index in 0..<of {
            let chunk = try file.read(upToCount: config.audioChunk) ?? Data()
            let r = try await s.request("uploadAudio", ["meetingId": rec.id, "chunk": chunk.base64EncodedString(), "index": index, "of": of, "mime": mime],
                                        // the last one waits for the import
                                        timeout: index == of - 1 ? .seconds(300) : .seconds(30))
            // done counts only with imported: until then the phone keeps its copy
            if r["done"] as? Bool == true {
                if r["imported"] as? Bool == true { return }
                throw SyncError.remote("failed")
            }
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
        // its own name, so two fetches of the same track can't write into one file
        let part = config.audioFolder.appending(path: "\(UUID().uuidString).part")
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
