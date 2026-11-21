import Foundation

/// What the desktop said to `hello`.
public struct DesktopHello: Sendable, Equatable {
    public var desktopId: String
    public var desktopName: String
    public var desktopVersion: String
    /// names the desktop's change log; another one means its database was replaced
    public var epoch: String?
    public init(desktopId: String, desktopName: String, desktopVersion: String = "", epoch: String?) {
        self.desktopId = desktopId; self.desktopName = desktopName; self.desktopVersion = desktopVersion; self.epoch = epoch
    }
}

/// An open session with the paired desktop: requests `{id, type, body}` answered `{id, type: ok|error, body}`.
/// The real one is Noise KK over TCP; tests use a stand-in desktop.
@MainActor
public protocol DesktopSession: AnyObject {
    var hello: DesktopHello { get }
    /// the ok body, or throws `SyncError.remote(code)` for an error reply
    func request(_ type: String, _ body: [String: Any], timeout: Duration) async throws -> [String: Any]
    /// for replies that come as several messages (`audio` → audioChunk): `each` gets every body until it returns true
    func stream(_ type: String, _ body: [String: Any], timeout: Duration, _ each: @escaping @MainActor ([String: Any]) throws -> Bool) async throws
    /// the desktop's log moved (`changed {cursor}`)
    var onChanged: (@MainActor () -> Void)? { get set }
    /// the connection ended, for whatever reason
    var onClose: (@MainActor () -> Void)? { get set }
    func close()
}

/// The JSON app layer over Noise transport messages, exactly as app/src/main/companion/session.ts and frames.ts:
/// a message over 60000 bytes goes as {chunk: base64 of the next 44000-byte slice, of}; `{type: "rekey"}` with no
/// id moves the sender's key, after 1 GiB or an hour.
@MainActor
public final class NoiseSession: DesktopSession {
    nonisolated static let chunkAt = 60000, chunkBytes = 44000, maxMessage = 64 * 1024 * 1024
    static let prologue = Data("yogurt-v1".utf8)

    public private(set) var hello = DesktopHello(desktopId: "", desktopName: "", epoch: nil)
    public var onChanged: (@MainActor () -> Void)?
    public var onClose: (@MainActor () -> Void)?

    private let transport: Transport
    private let tx: CipherState
    private let inbound: Inbound
    private let rekeyBytes: Int, rekeyAfter: Duration
    private var sent = 0
    private var sentSince = ContinuousClock.now
    private var writing: Task<Void, Never>?
    private var nextId = 0
    private var waiting: [String: CheckedContinuation<Reply, Error>] = [:]
    private var streams: [String: (each: @MainActor ([String: Any]) throws -> Bool, done: CheckedContinuation<Void, Error>)] = [:]
    private var closed = false

    init(transport: Transport, tx: CipherState, rx: CipherState, rekeyBytes: Int, rekeyAfter: Duration) {
        self.transport = transport; self.tx = tx; inbound = Inbound(rx: rx); self.rekeyBytes = rekeyBytes; self.rekeyAfter = rekeyAfter
    }

    /// Runs the handshake (the phone initiates) and `hello`. The desktop wants the first transport message within
    /// 3 s of its reply, so hello goes straight after. A desktop that closes instead of answering, or whose answer
    /// doesn't verify, doesn't know this phone: `SyncError.unrecognised`.
    public static func open(_ transport: Transport, phone: KeyPair, desktopKey: Data, appVersion: String,
                            rekeyBytes: Int = 1 << 30, rekeyAfter: Duration = .seconds(3600)) async throws -> NoiseSession {
        let noise = try NoiseKK(initiator: true, s: phone, rs: desktopKey, prologue: prologue)
        try await transport.send(noise.writeMessage(Data()))
        // a desktop that says nothing at all is slow or gone, not refusing: closing the transport ends the wait
        let late = Flag()
        let timer = Task { try await Task.sleep(for: .seconds(5)); late.set(); transport.close() }
        defer { timer.cancel() }
        let reply: Data
        do { reply = try await transport.receive() } catch { throw late.isSet ? SyncError.timeout : SyncError.unrecognised }
        do { _ = try noise.readMessage(reply) } catch { throw SyncError.unrecognised }
        let (send, recv) = try noise.split()
        let s = NoiseSession(transport: transport, tx: send, rx: recv, rekeyBytes: rekeyBytes, rekeyAfter: rekeyAfter)
        s.readLoop()
        do {
            let h = try await s.request("hello", ["appVersion": appVersion, "schema": 1], timeout: .seconds(10))
            s.hello = DesktopHello(desktopId: h["desktopId"] as? String ?? "", desktopName: h["desktopName"] as? String ?? "",
                                   desktopVersion: h["desktopVersion"] as? String ?? "", epoch: h["epoch"] as? String)
        } catch {
            s.close()
            throw error
        }
        return s
    }

    // MARK: - Requests

    public func request(_ type: String, _ body: [String: Any], timeout: Duration) async throws -> [String: Any] {
        guard !closed else { throw SyncError.closed }
        nextId += 1
        let id = String(nextId)
        let message: [String: Any] = ["id": id, "type": type, "body": body]
        let timer = Task { [weak self] in
            try await Task.sleep(for: timeout)
            self?.finish(id, .failure(SyncError.timeout))
        }
        defer { timer.cancel() }
        return try await withCheckedThrowingContinuation { (c: CheckedContinuation<Reply, Error>) in
            waiting[id] = c
            Task { do { try await self.write(message) } catch { self.finish(id, .failure(error)) } }
        }.body
    }

    public func stream(_ type: String, _ body: [String: Any], timeout: Duration, _ each: @escaping @MainActor ([String: Any]) throws -> Bool) async throws {
        guard !closed else { throw SyncError.closed }
        nextId += 1
        let id = String(nextId)
        let message: [String: Any] = ["id": id, "type": type, "body": body]
        // timeout counts from the last message, so a long file keeps going as long as it moves
        let last = LastHeard()
        let timer = Task { [weak self] in
            while true {
                try await Task.sleep(for: .seconds(1))
                if ContinuousClock.now - last.at > timeout { self?.endStream(id, SyncError.timeout); return }
            }
        }
        defer { timer.cancel() }
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            streams[id] = ({ body in last.at = .now; return try each(body) }, c)
            Task { do { try await self.write(message) } catch { self.endStream(id, error) } }
        }
    }

    private func finish(_ id: String, _ result: Result<[String: Any], Error>) {
        guard let c = waiting.removeValue(forKey: id) else { return }
        switch result {
        case .success(let body): c.resume(returning: Reply(body: body))
        case .failure(let e): c.resume(throwing: e)
        }
    }

    private func endStream(_ id: String, _ error: Error?) {
        guard let s = streams.removeValue(forKey: id) else { return }
        if let error { s.done.resume(throwing: error) } else { s.done.resume() }
    }

    // MARK: - Writing

    /// One message at a time, so the chunks of two never interleave and nonces stay in order.
    private func write(_ message: [String: Any]) async throws {
        let before = writing
        let job = Task { @MainActor in
            await before?.value
            try await self.writeNow(message)
        }
        writing = Task { _ = try? await job.value }
        try await job.value
    }

    private func writeNow(_ message: [String: Any]) async throws {
        guard !closed else { throw SyncError.closed }
        if sent >= rekeyBytes || ContinuousClock.now - sentSince >= rekeyAfter {
            try await put(tx.encrypt(Data(#"{"type":"rekey"}"#.utf8)))
            try tx.rekey()
            sent = 0
            sentSince = .now
        }
        for part in try Self.split(JSONSerialization.data(withJSONObject: message)) {
            let ct = try tx.encrypt(part)
            sent += ct.count
            try await put(ct)
        }
    }

    private func put(_ ct: Data) async throws {
        do { try await transport.send(ct) } catch { close(); throw SyncError.closed }
    }

    nonisolated static func split(_ bytes: Data) throws -> [Data] {
        guard bytes.count > chunkAt else { return [bytes] }
        guard bytes.count <= maxMessage else { throw SyncError.badMessage }
        let of = (bytes.count + chunkBytes - 1) / chunkBytes
        return try (0..<of).map { i in
            let slice = bytes[(bytes.startIndex + i * chunkBytes)..<min(bytes.endIndex, bytes.startIndex + (i + 1) * chunkBytes)]
            return try JSONSerialization.data(withJSONObject: ["chunk": Data(slice).base64EncodedString(), "of": of])
        }
    }

    // MARK: - Reading

    /// Decrypting and putting chunks together happen off the main actor; only whole messages come back to it.
    private func readLoop() {
        Task.detached { [weak self, transport, inbound] in
            defer { inbound.wipe() }
            while true {
                let reply: Reply
                do {
                    guard let msg = try inbound.take(try await transport.receive()) else { continue }
                    reply = Reply(body: msg)
                } catch {
                    await self?.close()
                    return
                }
                guard let self else { return }
                await self.deliver(reply)
            }
        }
    }

    private func deliver(_ reply: Reply) {
        guard !closed else { return }
        let msg = reply.body
        let type = msg["type"] as? String
        let id = msg["id"] as? String
        if type == "changed", id == nil { onChanged?(); return }
        guard let id else { return }
        let body = msg["body"] as? [String: Any] ?? [:]
        if let s = streams[id] {
            if type == "error" { endStream(id, SyncError.remote(body["code"] as? String ?? "failed")); return }
            do { if try s.each(body) { endStream(id, nil) } } catch { endStream(id, error) }
            return
        }
        switch type {
        case "ok", "pong": finish(id, .success(body))
        case "error": finish(id, .failure(SyncError.remote(body["code"] as? String ?? "failed")))
        default: break
        }
    }

    public func close() {
        guard !closed else { return }
        closed = true
        transport.close()
        // the receiving key is wiped by the reader as it stops (it may be mid-decrypt right now)
        tx.wipeKey()
        for id in Array(waiting.keys) { finish(id, .failure(SyncError.closed)) }
        for id in Array(streams.keys) { endStream(id, SyncError.closed) }
        onClose?()
    }
}

/// The receiving half of a session, used only by its reader task: decrypts, moves the key on `{type: "rekey"}`
/// (no id), and joins `{chunk, of}` parts into one buffer as they come (each byte copied once).
final class Inbound: @unchecked Sendable {
    private let rx: CipherState
    private var whole = Data(), of = 0, seen = 0

    init(rx: CipherState) { self.rx = rx }

    /// A whole app message, or nil while chunks are still coming (or for a rekey). Throws on anything malformed.
    func take(_ ct: Data) throws -> [String: Any]? {
        guard let msg = try reassemble(try rx.decrypt(ct)) else { return nil }
        if msg["type"] as? String == "rekey", msg["id"] == nil { try rx.rekey(); return nil }
        return msg
    }

    private func reassemble(_ plain: Data) throws -> [String: Any]? {
        guard let v = try JSONSerialization.jsonObject(with: plain) as? [String: Any] else { throw SyncError.badMessage }
        guard let chunk = v["chunk"] else {
            guard of == 0 else { throw SyncError.badMessage }
            return v
        }
        guard let chunk = chunk as? String, let part = Data(base64Encoded: chunk), let n = v["of"] as? Int, n >= 2,
              of == 0 || n == of, n <= NoiseSession.maxMessage / NoiseSession.chunkBytes + 1 else { throw SyncError.badMessage }
        if of == 0 { of = n; whole = Data(capacity: min(n * NoiseSession.chunkBytes, NoiseSession.maxMessage)) }
        guard whole.count + part.count <= NoiseSession.maxMessage else { throw SyncError.badMessage }
        whole.append(part)
        seen += 1
        guard seen == of else { return nil }
        let bytes = whole
        whole = Data(); of = 0; seen = 0
        guard let msg = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], msg["chunk"] == nil else { throw SyncError.badMessage }
        return msg
    }

    func wipe() { rx.wipeKey() }
}

/// A reply body handed across a continuation; it never leaves the main actor.
struct Reply: @unchecked Sendable { let body: [String: Any] }

final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set() { lock.lock(); value = true; lock.unlock() }
    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return value }
}

/// When a stream last heard something.
@MainActor final class LastHeard { var at = ContinuousClock.now }
