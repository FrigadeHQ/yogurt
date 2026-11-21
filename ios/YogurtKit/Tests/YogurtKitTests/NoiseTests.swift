import Foundation
import Testing
@testable import YogurtKit

private struct Message: Decodable { let payload: String; let ciphertext: String }
private struct Vector: Decodable {
    let init_prologue, init_static, init_ephemeral, init_remote_static: String
    let resp_prologue, resp_static, resp_ephemeral, resp_remote_static: String
    let handshake_hash: String?
    let messages: [Message]
}
private struct Vectors: Decodable { let vectors: [Vector] }
private struct Points: Decodable { let points: [String] }
private let vectors = try! fixture("noise-kk-vectors.json", as: Vectors.self).vectors
private let lowOrder = try! fixture("noise-low-order-points.json", as: Points.self).points
private let prologue = utf8("yogurt-v1")

private func pair() throws -> (a: KeyPair, b: KeyPair, i: NoiseKK, r: NoiseKK) {
    let a = KeyPair.generate(), b = KeyPair.generate()
    let i = try NoiseKK(initiator: true, s: a, rs: b.publicKey, prologue: prologue)
    let r = try NoiseKK(initiator: false, s: b, rs: a.publicKey, prologue: prologue)
    return (a, b, i, r)
}

private func handshake(_ i: NoiseKK, _ r: NoiseKK) throws {
    _ = try r.readMessage(i.writeMessage(Data()))
    _ = try i.readMessage(r.writeMessage(Data()))
}

@Suite struct NoiseTests {
    @Test(arguments: vectors.indices) func reproducesThePublishedVector(_ n: Int) throws {
        let v = vectors[n]
        let h = { (s: String) in Data(hex: s) }
        let i = try NoiseKK(initiator: true, s: try KeyPair(privateKey: h(v.init_static)), rs: h(v.init_remote_static),
                            prologue: h(v.init_prologue), testEphemeral: try KeyPair(privateKey: h(v.init_ephemeral)))
        let r = try NoiseKK(initiator: false, s: try KeyPair(privateKey: h(v.resp_static)), rs: h(v.resp_remote_static),
                            prologue: h(v.resp_prologue), testEphemeral: try KeyPair(privateKey: h(v.resp_ephemeral)))
        let messages = v.messages.map { (Data(hex: $0.payload), $0.ciphertext) }
        let c0 = try i.writeMessage(messages[0].0)
        #expect(c0.hex == messages[0].1)
        #expect(try r.readMessage(c0) == messages[0].0)
        let c1 = try r.writeMessage(messages[1].0)
        #expect(c1.hex == messages[1].1)
        #expect(try i.readMessage(c1) == messages[1].0)
        #expect(i.isDone && r.isDone)
        if let hh = v.handshake_hash { #expect(try i.handshakeHash().hex == hh) }
        #expect(try r.handshakeHash() == i.handshakeHash())

        let si = try i.split(), sr = try r.split()
        for (n, m) in messages.dropFirst(2).enumerated() {
            let (send, recv) = n % 2 == 0 ? (si.send, sr.recv) : (sr.send, si.recv)
            let ct = try send.encrypt(m.0)
            #expect(ct.hex == m.1)
            #expect(try recv.decrypt(ct) == m.0)
        }
    }

    @Test func aFreshHandshakeCarriesPayloadsBothWays() throws {
        let (_, _, i, r) = try pair()
        #expect(try r.readMessage(i.writeMessage(utf8("hi"))) == utf8("hi"))
        #expect(!i.isDone)
        #expect(try i.readMessage(r.writeMessage(utf8("hey"))) == utf8("hey"))
        let si = try i.split(), sr = try r.split()
        #expect(try sr.recv.decrypt(si.send.encrypt(utf8("one"))) == utf8("one"))
        #expect(try si.recv.decrypt(sr.send.encrypt(utf8("two"))) == utf8("two"))
    }

    @Test func throwsOnATamperedOrReplayedTransportMessage() throws {
        let (_, _, i, r) = try pair()
        try handshake(i, r)
        let si = try i.split(), sr = try r.split()
        let ct = try si.send.encrypt(utf8("secret"))
        var bad = ct; bad[0] ^= 1
        #expect(throws: CryptoError.self) { try sr.recv.decrypt(bad) }
        // the failed message must not use up a nonce
        #expect(try sr.recv.decrypt(ct) == utf8("secret"))
        #expect(throws: CryptoError.self) { try sr.recv.decrypt(ct) }
    }

    @Test func aResponderExpectingAnotherStaticKeyRejectsMessageOne() throws {
        let (_, _, i, _) = try pair()
        let r = try NoiseKK(initiator: false, s: .generate(), rs: KeyPair.generate().publicKey, prologue: prologue)
        let m = try i.writeMessage(Data())
        #expect(throws: CryptoError.self) { try r.readMessage(m) }
        // dead after a failure
        #expect(throws: CryptoError.self) { try r.writeMessage(Data()) }
    }

    @Test func aDifferentPrologueFails() throws {
        let a = KeyPair.generate(), b = KeyPair.generate()
        let i = try NoiseKK(initiator: true, s: a, rs: b.publicKey, prologue: prologue)
        let r = try NoiseKK(initiator: false, s: b, rs: a.publicKey, prologue: utf8("yogurt-v2"))
        let m = try i.writeMessage(Data())
        #expect(throws: CryptoError.self) { try r.readMessage(m) }
    }

    @Test(arguments: lowOrder) func rejectsASmallOrderEphemeralInMessageOne(_ point: String) throws {
        let (_, _, i, r) = try pair()
        var m = try i.writeMessage(Data())
        m.replaceSubrange(0..<32, with: Data(hex: point))
        #expect(throws: CryptoError.badPoint) { try r.readMessage(m) }
        #expect(throws: CryptoError.handshakeFailed) { try r.writeMessage(Data()) }
    }

    @Test(arguments: lowOrder) func refusesASmallOrderRemoteStaticKey(_ point: String) throws {
        // a low-order rs makes the first DH fail, so the initiator can't even write message 1
        let i = try NoiseKK(initiator: true, s: .generate(), rs: Data(hex: point), prologue: prologue)
        #expect(throws: CryptoError.self) { try i.writeMessage(Data()) }
        #expect(throws: CryptoError.self) { try i.writeMessage(Data()) }
    }

    @Test func refusesOutOfTurnCallsAndEarlyOrRepeatedSplit() throws {
        let (_, _, i, r) = try pair()
        #expect(throws: CryptoError.self) { try r.writeMessage(Data()) }
        #expect(throws: CryptoError.self) { try i.split() }
        #expect(throws: CryptoError.self) { try i.handshakeHash() }
        _ = try r.readMessage(i.writeMessage(Data()))
        #expect(throws: CryptoError.self) { try i.writeMessage(Data()) }
        _ = try i.readMessage(r.writeMessage(Data()))
        _ = try i.split()
        #expect(throws: CryptoError.self) { try i.split() }
    }

    @Test func enforcesTheMessageSizeLimit() throws {
        let (_, _, i, r) = try pair()
        #expect(throws: CryptoError.self) { try i.writeMessage(Data(count: 65535 - 48 + 1)) }
        let m = try i.writeMessage(Data(count: 65535 - 48))
        #expect(m.count == 65535)
        _ = try r.readMessage(m)
        _ = try i.readMessage(r.writeMessage(Data()))
        let si = try i.split(), sr = try r.split()
        #expect(throws: CryptoError.self) { try si.send.encrypt(Data(count: 65535 - 16 + 1)) }
        #expect(try sr.recv.decrypt(si.send.encrypt(Data(count: 65000))).count == 65000)
        #expect(throws: CryptoError.self) { try sr.recv.decrypt(Data(count: 65536)) }
    }

    @Test func transportCiphersNeedA32ByteKey() {
        #expect(throws: CryptoError.self) { try CipherState(key: Data(count: 31)) }
    }

    @Test func rekeyChangesTheKeyTheSameWayOnBothEnds() throws {
        let k = Data.random(32)
        let a = try CipherState(key: k), b = try CipherState(key: k)
        try a.rekey(); try b.rekey()
        #expect(try b.decrypt(a.encrypt(utf8("after"))) == utf8("after"))
        let c = try CipherState(key: k), d = try CipherState(key: k)
        try d.rekey()
        #expect(throws: CryptoError.self) { try c.decrypt(d.encrypt(utf8("x"))) }
    }

    @Test func generatesX25519KeyPairs() throws {
        let k = KeyPair.generate()
        #expect(k.publicKey.count == 32)
        #expect(try KeyPair(privateKey: k.privateKey).publicKey == k.publicKey)
    }
}
