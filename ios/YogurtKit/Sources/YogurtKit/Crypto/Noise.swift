import Clibsodium
import Foundation

// Noise_KK_25519_ChaChaPoly_BLAKE2b (Noise spec rev 34). Both static keys are known from pairing:
//   -> s  <- s  ...  -> e, es, ss  <- e, ee, se
// Mirrors app/src/main/companion/noise.ts.

let noiseMaxMessage = 65535

/// One direction of an encrypted channel; transport ciphers are always keyed. Not thread-safe: use each from one place at a time.
public final class CipherState {
    private var k: Data?
    private var n: UInt64 = 0
    static let maxNonce = UInt64.max

    /// A transport cipher; the key must be 32 bytes.
    public convenience init(key: Data) throws {
        guard key.count == 32 else { throw CryptoError.badKey }
        self.init(optionalKey: key)
    }

    init(optionalKey: Data?) { k = optionalKey }

    // 4 zero bytes then the 64-bit counter, little-endian
    static func nonce(_ n: UInt64) -> Data { Data(count: 4) + withUnsafeBytes(of: n.littleEndian) { Data($0) } }

    func encryptWithAd(_ ad: Data, _ pt: Data) throws -> Data {
        guard let k else { return pt }
        guard n < Self.maxNonce else { throw CryptoError.nonceExhausted }
        guard pt.count + 16 <= noiseMaxMessage else { throw CryptoError.badLength }
        let ct = Sodium.seal(pt, ad: ad, nonce: Self.nonce(n), key: k, crypto_aead_chacha20poly1305_ietf_encrypt)
        n += 1
        return ct
    }

    /// Throws on a changed, replayed or out-of-order message; the counter only moves on success.
    func decryptWithAd(_ ad: Data, _ ct: Data) throws -> Data {
        guard let k else { return ct }
        guard n < Self.maxNonce else { throw CryptoError.nonceExhausted }
        guard ct.count <= noiseMaxMessage else { throw CryptoError.badLength }
        let pt = try Sodium.open(ct, ad: ad, nonce: Self.nonce(n), key: k, crypto_aead_chacha20poly1305_ietf_decrypt)
        n += 1
        return pt
    }

    public func encrypt(_ pt: Data) throws -> Data { try encryptWithAd(Data(), pt) }
    public func decrypt(_ ct: Data) throws -> Data { try decryptWithAd(Data(), ct) }

    public func rekey() throws {
        guard let k else { throw CryptoError.badKey }
        let next = Sodium.seal(Data(count: 32), ad: Data(), nonce: Self.nonce(Self.maxNonce), key: k, crypto_aead_chacha20poly1305_ietf_encrypt)
        self.k = next.prefix(32)
    }

    func wipeKey() {
        if var key = k { wipe(&key) }
        k = nil
    }
}

final class SymmetricState {
    static let proto = "Noise_KK_25519_ChaChaPoly_BLAKE2b"
    private(set) var h: Data
    private var ck: Data
    private var cipher = CipherState(optionalKey: nil)

    init() {
        // shorter than HASHLEN, so zero-padded rather than hashed
        var h = Data(Self.proto.utf8)
        h.append(Data(count: 64 - h.count))
        self.h = h
        ck = h
    }

    func mixHash(_ data: Data) { h = Sodium.blake2b(h + data) }

    /// Wipes ikm (always a DH output here) once mixed in; best effort, Data may keep copies.
    func mixKey(_ ikm: Data) {
        var ikm = ikm
        let (ck, k) = NoiseHKDF.hkdf(ck: self.ck, ikm: ikm)
        wipe(&ikm)
        wipe(&self.ck)
        self.ck = ck
        cipher.wipeKey()
        cipher = CipherState(optionalKey: k.prefix(32))
    }

    func encryptAndHash(_ pt: Data) throws -> Data {
        let ct = try cipher.encryptWithAd(h, pt)
        mixHash(ct)
        return ct
    }

    func decryptAndHash(_ ct: Data) throws -> Data {
        let pt = try cipher.decryptWithAd(h, ct)
        mixHash(ct)
        return pt
    }

    /// The two transport ciphers; the chaining key and handshake cipher are wiped after.
    func split() -> (CipherState, CipherState) {
        let (a, b) = NoiseHKDF.hkdf(ck: ck, ikm: Data())
        wipe(&ck)
        cipher.wipeKey()
        return (CipherState(optionalKey: a.prefix(32)), CipherState(optionalKey: b.prefix(32)))
    }
}

/// One Noise KK handshake. Not thread-safe.
public final class NoiseKK {
    private let ss = SymmetricState()
    private let initiator: Bool
    private let s: KeyPair
    private let rs: Data
    private var e: KeyPair?
    private var re: Data?
    private var step = 0
    private var failed = false
    private var didSplit = false

    /// `rs` is the other side's static public key, known from pairing. `testEphemeral` is for test vectors only.
    public init(initiator: Bool, s: KeyPair, rs: Data, prologue: Data, testEphemeral: KeyPair? = nil) throws {
        guard rs.count == 32 else { throw CryptoError.badKey }
        self.initiator = initiator
        self.s = s
        self.rs = rs
        e = testEphemeral
        ss.mixHash(prologue)
        ss.mixHash(initiator ? s.publicKey : rs)
        ss.mixHash(initiator ? rs : s.publicKey)
    }

    public var isDone: Bool { step == 2 }

    /// Same on both ends once done; usable as a channel binding.
    public func handshakeHash() throws -> Data {
        guard isDone else { throw CryptoError.notDone }
        return ss.h
    }

    private var myTurn: Bool { (step == 0) == initiator }

    private func check(writing: Bool) throws {
        if failed { throw CryptoError.handshakeFailed }
        if isDone { throw CryptoError.handshakeDone }
        if myTurn != writing { throw CryptoError.notYourTurn }
    }

    // es/ss for message 1, ee/se for message 2, from whichever side is running
    private func mixDh() throws {
        if step == 0 {
            ss.mixKey(initiator ? try e!.dh(rs) : try s.dh(re!))
            ss.mixKey(try s.dh(rs))
        } else {
            ss.mixKey(try e!.dh(re!))
            ss.mixKey(initiator ? try s.dh(re!) : try e!.dh(rs))
        }
    }

    // the ephemeral key is only needed until both DH steps that use it are done
    private func advance() {
        step += 1
        if isDone { e = nil }
    }

    /// Any failure ends the handshake: it can't continue in a half-mixed state.
    private func guarded<T>(_ f: () throws -> T) throws -> T {
        do { return try f() } catch { failed = true; throw error }
    }

    /// Throws on a bad remote key (the handshake is dead after that) or an oversized payload.
    public func writeMessage(_ payload: Data) throws -> Data {
        try check(writing: true)
        guard 32 + payload.count + 16 <= noiseMaxMessage else { throw CryptoError.badLength }
        return try guarded {
            let e = self.e ?? KeyPair.generate()
            self.e = e
            ss.mixHash(e.publicKey)
            try mixDh()
            let msg = e.publicKey + (try ss.encryptAndHash(payload))
            advance()
            return msg
        }
    }

    /// Throws when the message wasn't made by the expected peer.
    public func readMessage(_ msg: Data) throws -> Data {
        try check(writing: false)
        return try guarded {
            guard msg.count >= 32 + 16, msg.count <= noiseMaxMessage else { throw CryptoError.badLength }
            let msg = Data(msg) // rebase so indices start at 0
            re = msg.prefix(32)
            ss.mixHash(re!)
            try mixDh()
            let payload = try ss.decryptAndHash(Data(msg.dropFirst(32)))
            advance()
            return payload
        }
    }

    /// The transport ciphers for this side: send to the peer, receive from the peer. Only once.
    public func split() throws -> (send: CipherState, recv: CipherState) {
        guard isDone else { throw CryptoError.notDone }
        guard !didSplit else { throw CryptoError.alreadySplit }
        didSplit = true
        let (c1, c2) = ss.split()
        return initiator ? (c1, c2) : (c2, c1)
    }
}
