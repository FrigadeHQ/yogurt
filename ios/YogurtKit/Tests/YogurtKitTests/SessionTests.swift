import Foundation
import Testing
@testable import YogurtKit

/// One direction of an in-memory connection.
private final class Pipe: @unchecked Sendable {
    private let lock = NSLock()
    private var queue: [Data] = []
    private var waiter: CheckedContinuation<Data, Error>?
    private var closed = false

    func push(_ d: Data) {
        lock.lock()
        if let w = waiter { waiter = nil; lock.unlock(); w.resume(returning: d); return }
        queue.append(d)
        lock.unlock()
    }

    func pop() async throws -> Data {
        try await withCheckedThrowingContinuation { c in
            lock.lock()
            if !queue.isEmpty { let d = queue.removeFirst(); lock.unlock(); c.resume(returning: d); return }
            if closed { lock.unlock(); c.resume(throwing: SyncError.closed); return }
            waiter = c
            lock.unlock()
        }
    }

    func close() {
        lock.lock()
        closed = true
        let w = waiter
        waiter = nil
        lock.unlock()
        w?.resume(throwing: SyncError.closed)
    }
}

private final class End: Transport, @unchecked Sendable {
    let inbox: Pipe, outbox: Pipe
    init(_ inbox: Pipe, _ outbox: Pipe) { self.inbox = inbox; self.outbox = outbox }
    func send(_ payload: Data) async throws { outbox.push(payload) }
    func receive() async throws -> Data { try await inbox.pop() }
    func close() { inbox.close(); outbox.close() }
}

private func pair() -> (phone: End, desktop: End) {
    let a = Pipe(), b = Pipe()
    return (End(a, b), End(b, a))
}

private func json(_ o: [String: Any]) -> Data { try! JSONSerialization.data(withJSONObject: o) }

/// The desktop's side of a session in Swift: Noise KK responder, chunking and rekey as session.ts does them.
private final class DesktopSide: @unchecked Sendable {
    let t: End
    var tx: CipherState!, rx: CipherState!
    var parts: [Data] = []
    var rekeysSeen = 0

    init(_ t: End) { self.t = t }

    func handshake(desktop: KeyPair, phoneKey: Data) async throws {
        let noise = try NoiseKK(initiator: false, s: desktop, rs: phoneKey, prologue: Data("yogurt-v1".utf8))
        _ = try noise.readMessage(try await t.receive())
        try await t.send(noise.writeMessage(Data()))
        (tx, rx) = try noise.split()
    }

    func next() async throws -> [String: Any] {
        while true {
            let v = try JSONSerialization.jsonObject(with: try rx.decrypt(try await t.receive())) as! [String: Any]
            if v["type"] as? String == "rekey" { try rx.rekey(); rekeysSeen += 1; continue }
            if let chunk = v["chunk"] as? String {
                parts.append(Data(base64Encoded: chunk)!)
                guard parts.count == v["of"] as! Int else { continue }
                let whole = parts.reduce(Data(), +)
                parts = []
                return try JSONSerialization.jsonObject(with: whole) as! [String: Any]
            }
            return v
        }
    }

    func send(_ o: [String: Any], rekeyFirst: Bool = false) async throws {
        if rekeyFirst {
            try await t.send(tx.encrypt(json(["type": "rekey"])))
            try tx.rekey()
        }
        for part in try NoiseSession.split(json(o)) { try await t.send(tx.encrypt(part)) }
    }
}

@MainActor @Suite struct SessionTests {
    let phone = KeyPair.generate(), desktop = KeyPair.generate()

    @Test func bigMessagesGoInChunksBothWaysAndBothSidesRekey() async throws {
        let (p, d) = pair()
        let side = DesktopSide(d)
        let big = String(repeating: "made-up words ", count: 12_000)
        let server = Task.detached { [desktop, phone] in
            try await side.handshake(desktop: desktop, phoneKey: phone.publicKey)
            let hello = try await side.next()
            #expect(hello["type"] as? String == "hello")
            #expect((hello["body"] as? [String: Any])?["schema"] as? Int == 1)
            try await side.send(["id": hello["id"]!, "type": "ok", "body": ["desktopId": "d1", "desktopName": "Test Mac", "desktopVersion": "1", "epoch": "e1"]])
            try await side.send(["type": "changed", "body": ["cursor": 3]])
            for i in 0..<2 {
                let req = try await side.next()
                let text = (req["body"] as? [String: Any])?["text"] as? String ?? ""
                // the desktop moves its own sending key before the second reply
                try await side.send(["id": req["id"]!, "type": "ok", "body": ["text": text]], rekeyFirst: i == 1)
            }
            let bad = try await side.next()
            try await side.send(["id": bad["id"]!, "type": "error", "body": ["code": "gone"]])
            return side.rekeysSeen
        }
        let s = try await NoiseSession.open(p, phone: phone, desktopKey: desktop.publicKey, appVersion: "1.0", rekeyBytes: 100_000)
        #expect(s.hello == DesktopHello(desktopId: "d1", desktopName: "Test Mac", desktopVersion: "1", epoch: "e1"))
        var changed = false
        s.onChanged = { changed = true }
        for _ in 0..<2 {
            let r = try await s.request("echo", ["text": big], timeout: .seconds(5))
            #expect(r["text"] as? String == big)
        }
        await #expect(throws: SyncError.remote("gone")) { _ = try await s.request("op", [:], timeout: .seconds(5)) }
        #expect(changed)
        // the phone's sending key moved each time it had sent more than the limit (before the 2nd and 3rd request)
        #expect(try await server.value == 2)
        s.close()
    }

    @Test func aDesktopThatClosesAfterTheFirstHandshakeMessageDoesNotKnowThisPhone() async throws {
        let (p, d) = pair()
        Task.detached { _ = try await d.receive(); d.close() }
        await #expect(throws: SyncError.unrecognised) {
            try await NoiseSession.open(p, phone: phone, desktopKey: desktop.publicKey, appVersion: "1.0")
        }
    }

    @Test func anAnswerThatDoesNotVerifyIsRefused() async throws {
        let (p, d) = pair()
        // something answers that isn't the paired desktop: it can't make a message 2 that verifies
        Task.detached { _ = try await d.receive(); try await d.send(Data.random(48)) }
        await #expect(throws: SyncError.unrecognised) {
            try await NoiseSession.open(p, phone: phone, desktopKey: desktop.publicKey, appVersion: "1.0")
        }
    }

    @Test func aClosedSessionFailsWhatIsWaitingAndSaysSo() async throws {
        let (p, d) = pair()
        let side = DesktopSide(d)
        Task.detached { [desktop, phone] in
            try await side.handshake(desktop: desktop, phoneKey: phone.publicKey)
            let hello = try await side.next()
            try await side.send(["id": hello["id"]!, "type": "ok", "body": ["desktopId": "d1", "desktopName": "Mac"]])
            _ = try await side.next()
            d.close()
        }
        let s = try await NoiseSession.open(p, phone: phone, desktopKey: desktop.publicKey, appVersion: "1.0")
        var closed = false
        s.onClose = { closed = true }
        await #expect(throws: SyncError.closed) { _ = try await s.request("pull", ["since": 0], timeout: .seconds(5)) }
        #expect(closed)
    }

    @Test func anEightMegabyteMessageComesBackWholeAndQuickly() throws {
        let key = Data.random(32)
        let tx = try CipherState(key: key), inbound = Inbound(rx: try CipherState(key: key))
        let text = String(repeating: "made-up words ", count: 600_000)
        let parts = try NoiseSession.split(JSONSerialization.data(withJSONObject: ["id": "1", "type": "ok", "body": ["text": text]]))
        #expect(parts.count > 180)
        let start = ContinuousClock.now
        var whole: [String: Any]?
        for p in parts { whole = try inbound.take(tx.encrypt(p)) ?? whole }
        #expect(ContinuousClock.now - start < .seconds(5))
        #expect((whole?["body"] as? [String: Any])?["text"] as? String == text)
    }
}
