import Foundation
import Network

/// Everything sync can fail with. Messages to people are made from these by the engine, never shown raw.
public enum SyncError: Error, Equatable, Sendable {
    case closed, timeout, badMessage, notConnected, notPaired
    /// iOS won't let Yogurt use the local network (Settings → Privacy → Local Network)
    case localNetworkDenied
    /// the desktop answered `{type: "error", body: {code}}`
    case remote(String)
    /// the desktop closed the handshake or it didn't verify: it doesn't know this phone's key (any more)
    case unrecognised
    /// the computer's audio is a kind this iPhone can't play (ogg from Windows or Linux)
    case unplayableAudio
}

/// One connection to the desktop, as whole frames: each is a 2-byte big-endian length then that many bytes
/// (app/src/main/companion/frames.ts). `receive` is called by one reader at a time.
public protocol Transport: AnyObject, Sendable {
    func send(_ payload: Data) async throws
    func receive() async throws -> Data
    func close()
}

/// A resume-once guard for continuations that several callbacks race to finish.
final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func run(_ f: () -> Void) {
        lock.lock()
        let first = !done
        done = true
        lock.unlock()
        if first { f() }
    }
}

/// TCP through Network.framework, so Bonjour endpoints resolve and the local network permission is asked for.
public final class NWTransport: Transport, @unchecked Sendable {
    private let connection: NWConnection
    private static let queue = DispatchQueue(label: "chat.yogurt.transport")

    private init(_ connection: NWConnection) { self.connection = connection }

    /// Connects, or throws once `timeout` passes or the network says it can't (Wi-Fi off, nobody listening).
    public static func connect(to endpoint: NWEndpoint, timeout: Duration = .seconds(5)) async throws -> NWTransport {
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        tcp.connectionTimeout = Int(timeout.components.seconds)
        let connection = NWConnection(to: endpoint, using: NWParameters(tls: nil, tcp: tcp))
        let once = Once()
        return try await withCheckedThrowingContinuation { (c: CheckedContinuation<NWTransport, Error>) in
            let fail: @Sendable (Error) -> Void = { error in once.run { connection.cancel(); c.resume(throwing: error) } }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready: once.run { c.resume(returning: NWTransport(connection)) }
                // waiting means it can't connect right now; sync retries on its own schedule instead
                case .waiting(let e), .failed(let e): fail(isLocalNetworkDenied(e) ? SyncError.localNetworkDenied : e)
                case .cancelled: fail(SyncError.closed)
                default: break
                }
            }
            connection.start(queue: queue)
            queue.asyncAfter(deadline: .now() + .milliseconds(Int(timeout.components.seconds * 1000))) { fail(SyncError.timeout) }
        }
    }

    public func send(_ payload: Data) async throws {
        guard payload.count <= 65535 else { throw SyncError.badMessage }
        let frame = Data([UInt8(payload.count >> 8), UInt8(payload.count & 0xff)]) + payload
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            connection.send(content: frame, completion: .contentProcessed { error in
                if let error { c.resume(throwing: error) } else { c.resume() }
            })
        }
    }

    public func receive() async throws -> Data {
        let head = try await read(2)
        let length = Int(head[head.startIndex]) << 8 | Int(head[head.startIndex + 1])
        return length == 0 ? Data() : try await read(length)
    }

    private func read(_ n: Int) async throws -> Data {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Data, Error>) in
            connection.receive(minimumIncompleteLength: n, maximumLength: n) { data, _, _, error in
                if let data, data.count == n { c.resume(returning: data) }
                else { c.resume(throwing: error ?? SyncError.closed) }
            }
        }
    }

    public func close() { connection.cancel() }
}

/// What Network.framework reports when the person said no to Local Network for this app.
public func isLocalNetworkDenied(_ error: NWError) -> Bool {
    if case .dns(let code) = error { return code == DNSServiceErrorType(kDNSServiceErr_PolicyDenied) }
    return false
}
