import Foundation
import Testing
@testable import YogurtKit

// Pairs and talks with the desktop's own TypeScript crypto (app/scripts/companion-peer.mjs), so both
// implementations are checked against each other, not only against the published vectors.

private let repo = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()
private let peerScript = repo.appendingPathComponent("app/scripts/companion-peer.mjs")

private let nodePath: String? = ProcessInfo.processInfo.environment["PATH"]?
    .split(separator: ":").map { "\($0)/node" }
    .first { FileManager.default.isExecutableFile(atPath: $0) }

private struct PeerError: Error, CustomStringConvertible { let description: String }

/// The Node peer playing the desktop: listens on a free localhost port and reports what it derived as JSON lines.
private final class DesktopPeer {
    let process = Process()
    private let out = Pipe()
    // the peer exits when this closes, so a crashed test run leaves no stray node process
    private let stdin = Pipe()
    let port: UInt16

    init(code: String) throws {
        process.executableURL = URL(fileURLWithPath: nodePath!)
        process.arguments = [peerScript.path, "desktop", "0", code]
        var env = ProcessInfo.processInfo.environment
        env["NODE_OPTIONS"] = ""
        process.environment = env
        process.standardOutput = out
        process.standardInput = stdin
        try process.run()
        guard let p = try Self.line(out)["listening"] as? Int else { throw PeerError(description: "peer did not start") }
        port = UInt16(p)
    }

    func report() throws -> [String: Any] { try Self.line(out) }

    private static func line(_ pipe: Pipe) throws -> [String: Any] {
        var bytes = Data()
        let fd = pipe.fileHandleForReading.fileDescriptor
        var b: UInt8 = 0
        while true {
            guard read(fd, &b, 1) == 1 else { throw PeerError(description: "peer exited early") }
            if b == 0x0a { break }
            bytes.append(b)
        }
        return try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
    }

    deinit {
        try? stdin.fileHandleForWriting.close()
        if process.isRunning { process.terminate() }
    }
}

/// A blocking localhost TCP client speaking the wire framing: 2-byte big-endian length, then the payload.
private final class Conn {
    private let fd: Int32

    init(port: UInt16) throws {
        fd = socket(AF_INET, SOCK_STREAM, 0)
        var timeout = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard rc == 0 else { close(fd); throw PeerError(description: "connect failed") }
    }

    deinit { close(fd) }

    func send(_ payload: Data) throws {
        let frame = Data([UInt8(payload.count >> 8), UInt8(payload.count & 0xff)]) + payload
        let sent = frame.withUnsafeBytes { Darwin.send(fd, $0.baseAddress, frame.count, 0) }
        guard sent == frame.count else { throw PeerError(description: "send failed") }
    }

    func receive() throws -> Data {
        let len = try exactly(2)
        return try exactly(Int(len[0]) << 8 | Int(len[1]))
    }

    private func exactly(_ n: Int) throws -> Data {
        var buf = [UInt8](repeating: 0, count: n), got = 0
        while got < n {
            let r = buf.withUnsafeMutableBytes { recv(fd, $0.baseAddress! + got, n - got, 0) }
            guard r > 0 else { throw PeerError(description: "connection closed") }
            got += r
        }
        return Data(buf)
    }

    func send(json: [String: Any]) throws { try send(JSONSerialization.data(withJSONObject: json)) }
    func receiveJSON() throws -> [String: Any] { try JSONSerialization.jsonObject(with: receive()) as! [String: Any] }
}

private func b64(_ d: Data) -> String { d.base64EncodedString() }
private func unb64(_ v: Any?) -> Data { Data(base64Encoded: v as! String)! }

private struct Paired { let isk: Data; let desktopKey: Data?; let result: [String: Any] }

/// The phone's side of pairing, as the wire protocol lays it out. A wrong code still answers pairDone,
/// because the desktop decides and counts the attempt.
private func pairAsPhone(port: UInt16, code: String, phone: KeyPair) throws -> Paired {
    let c = try Conn(port: port)
    let phoneSession = Data.random(16)
    try c.send(json: ["type": "pairHello", "v": 1, "phoneSession": b64(phoneSession), "phoneName": "Test iPhone"])
    let start = try c.receiveJSON()
    #expect(start["type"] as? String == "pairStart")
    let desktopSession = unb64(start["desktopSession"])
    let sid = desktopSession + phoneSession
    let ci = Data("yogurt-pair-v1".utf8) + desktopSession + phoneSession
    let (yb, isk) = try CPace.respond(prs: code, ci: ci, sid: sid, ya: unb64(start["ya"]))
    try c.send(json: ["type": "pairReply", "yb": b64(yb)])
    let keys = PairKeys(isk: isk)

    let confirm = try c.receiveJSON()
    #expect(confirm["type"] as? String == "pairConfirm")
    let opened = try? Box.open(key: keys.toPhone, box: unb64(confirm["box"]), ad: Data("pairConfirm".utf8))
    let desktop = opened.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    let mine = try JSONSerialization.data(withJSONObject: ["key": b64(phone.publicKey), "name": "Test iPhone"])
    try c.send(json: ["type": "pairDone", "box": b64(try Box.seal(key: keys.toDesktop, plaintext: mine, ad: Data("pairDone".utf8)))])
    return Paired(isk: isk, desktopKey: desktop.map { unb64($0["key"]) }, result: try c.receiveJSON())
}

@Suite(.enabled(if: nodePath != nil, "node is not on PATH, so the Swift/Node interop tests are skipped"))
struct InteropTests {
    @Test func pairsWithTheDesktopThenEchoesOverNoiseKK() throws {
        let peer = try DesktopPeer(code: "482913")
        let phone = KeyPair.generate()
        let paired = try pairAsPhone(port: peer.port, code: "482913", phone: phone)
        #expect(paired.result["type"] as? String == "pairOk")
        let report = try #require(try peer.report()["paired"] as? [String: String])
        #expect(report["isk"] == paired.isk.hex)
        #expect(report["phoneKey"] == phone.publicKey.hex)
        let desktopKey = try #require(paired.desktopKey)
        #expect(report["desktopKey"] == desktopKey.hex)

        let c = try Conn(port: peer.port)
        let noise = try NoiseKK(initiator: true, s: phone, rs: desktopKey, prologue: Data("yogurt-v1".utf8))
        try c.send(noise.writeMessage(Data()))
        _ = try noise.readMessage(c.receive())
        let (send, recv) = try noise.split()
        for message in [Data("hello".utf8), Data.random(65000), Data("bye".utf8)] {
            try c.send(send.encrypt(message))
            #expect(try recv.decrypt(c.receive()) == message)
        }
    }

    @Test func aWrongCodeFailsWithCode() throws {
        let peer = try DesktopPeer(code: "482913")
        let paired = try pairAsPhone(port: peer.port, code: "482914", phone: .generate())
        #expect(paired.desktopKey == nil)
        #expect(paired.result["type"] as? String == "pairFail")
        #expect(paired.result["reason"] as? String == "code")
    }
}
