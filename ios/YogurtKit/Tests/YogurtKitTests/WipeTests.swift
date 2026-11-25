import Foundation
import Testing
@testable import YogurtKit

// Wipes must zero the very bytes the crypto used, not a copy of them.
@Suite struct WipeTests {
    @Test func secureBytesWipeInPlace() {
        let s = SecureBytes(Data([1, 2, 3, 4]))
        #expect(s.data == Data([1, 2, 3, 4]))
        s.wipe()
        #expect(s.isZero)
        #expect(SecureBytes(count: 0).isZero)
    }

    @Test func aCipherWipesItsOwnKey() throws {
        let c = try CipherState(key: .random(32))
        let key = try #require(c.keyStorage)
        #expect(!key.isZero)
        c.wipeKey()
        #expect(key.isZero)
        #expect(throws: CryptoError.self) { try c.encrypt(Data()) }
    }

    @Test func rekeyWipesTheOldKey() throws {
        let c = try CipherState(key: .random(32))
        let old = try #require(c.keyStorage)
        try c.rekey()
        #expect(old.isZero)
        #expect(try !#require(c.keyStorage).isZero)
    }

    @Test func mixKeyWipesTheDHOutput() {
        let ss = SymmetricState()
        let ikm = SecureBytes(Data.random(32))
        ss.mixKey(ikm)
        #expect(ikm.isZero)
    }

    @Test func splitWipesTheChainingKeyHandshakeKeyAndEphemeral() throws {
        let a = KeyPair.generate(), b = KeyPair.generate()
        let i = try NoiseKK(initiator: true, s: a, rs: b.publicKey, prologue: Data())
        let r = try NoiseKK(initiator: false, s: b, rs: a.publicKey, prologue: Data())
        _ = try r.readMessage(i.writeMessage(Data()))
        let ephemeral = try #require(i.ephemeralStorage).privateKey
        _ = try i.readMessage(r.writeMessage(Data()))
        #expect(ephemeral.isZero)
        #expect(i.ephemeralStorage == nil)
        let ck = i.symmetric.ckStorage, k = try #require(i.symmetric.cipherKeyStorage)
        #expect(!ck.isZero && !k.isZero)
        _ = try i.split()
        #expect(ck.isZero)
        #expect(k.isZero)
    }

    @Test func cpaceWipesTheScalarItUsed() throws {
        let ci = utf8("ci"), sid = Data.random(16)
        let a = try CPace.start(prs: "1", ci: ci, sid: sid)
        let scalar = a.secret.scalarStorage
        #expect(!scalar.isZero)
        let b = try CPace.respond(prs: "1", ci: ci, sid: sid, ya: a.ya)
        _ = try CPace.finish(secret: a.secret, yb: b.yb)
        #expect(scalar.isZero)
    }

    @Test func cpaceWipesTheScalarWhenFinishFails() throws {
        let a = try CPace.start(prs: "1", ci: utf8("ci"), sid: .random(16))
        #expect(throws: CryptoError.badPoint) { try CPace.finish(secret: a.secret, yb: Data(count: 32)) }
        #expect(a.secret.scalarStorage.isZero)
    }
}

@Suite struct NonceTests {
    @Test func theLastNonceIsReservedForRekey() throws {
        let k = Data.random(32)
        let a = try CipherState(key: SecureBytes(k), nonce: UInt64.max - 1)
        let b = try CipherState(key: SecureBytes(k), nonce: UInt64.max - 1)
        #expect(try b.decrypt(a.encrypt(utf8("last"))) == utf8("last"))
        #expect(throws: CryptoError.nonceExhausted) { try a.encrypt(Data()) }
        #expect(throws: CryptoError.nonceExhausted) { try b.decrypt(Data(count: 16)) }
        // rekey still works with the counter at the end, and leaves it there
        try a.rekey(); try b.rekey()
        #expect(throws: CryptoError.nonceExhausted) { try a.encrypt(Data()) }
    }

    @Test func rekeyWorksAtAnyCounter() throws {
        let k = Data.random(32)
        let a = try CipherState(key: SecureBytes(k), nonce: 7), b = try CipherState(key: SecureBytes(k), nonce: 7)
        try a.rekey(); try b.rekey()
        #expect(try b.decrypt(a.encrypt(utf8("x"))) == utf8("x"))
    }
}
