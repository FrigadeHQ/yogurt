import Clibsodium
import Foundation

// Noise_KK_25519_ChaChaPoly_BLAKE2b (Noise spec rev 34). Both static keys are known from pairing:
//   -> s  <- s  ...  -> e, es, ss  <- e, ee, se
// Mirrors app/src/main/companion/noise.ts. Keys, DH outputs and HKDF outputs live in SecureBytes and are
// wiped in place once used.

let noiseMaxMessage = 65535

/// One direction of an encrypted channel; always keyed. Not thread-safe: use each from one place at a time.
public final class CipherState {
    private(set) var keyStorage: SecureBytes?
    private(set) var n: UInt64
    static let maxNonce = UInt64.max

    /// A transport cipher; the key must be 32 bytes. It's copied into owned storage.
    public convenience init(key: Data) throws {
        try self.init(key: SecureBytes(key))
    }

    /// Takes ownership of `key`. `nonce` other than 0 is for tests.
    init(key: SecureBytes, nonce: UInt64 = 0) throws {
        guard key.count == 32 else { throw CryptoError.badKey }
        keyStorage = key
        n = nonce
    }

    // 4 zero bytes then the 64-bit counter, little-endian
    static func nonce(_ n: UInt64) -> Data { Data(count: 4) + withUnsafeBytes(of: n.littleEndian) { Data($0) } }

    // 2^64-1 is reserved for rekey, so both directions stop one short of it
    func encryptWithAd(_ ad: Data, _ pt: Data) throws -> Data {
        guard let k = keyStorage else { throw CryptoError.badKey }
        guard n < Self.maxNonce else { throw CryptoError.nonceExhausted }
        guard pt.count + 16 <= noiseMaxMessage else { throw CryptoError.badLength }
        let ct = Sodium.seal(pt, ad: ad, nonce: Self.nonce(n), key: k, crypto_aead_chacha20poly1305_ietf_encrypt)
        n += 1
        return ct
    }

    /// Throws on a changed, replayed or out-of-order message; the counter only moves on success.
    func decryptWithAd(_ ad: Data, _ ct: Data) throws -> Data {
        guard let k = keyStorage else { throw CryptoError.badKey }
        guard n < Self.maxNonce else { throw CryptoError.nonceExhausted }
        guard ct.count <= noiseMaxMessage else { throw CryptoError.badLength }
        let pt = try Sodium.open(ct, ad: ad, nonce: Self.nonce(n), key: k, crypto_aead_chacha20poly1305_ietf_decrypt)
        n += 1
        return pt
    }

    public func encrypt(_ pt: Data) throws -> Data { try encryptWithAd(Data(), pt) }
    public func decrypt(_ ct: Data) throws -> Data { try decryptWithAd(Data(), ct) }

    /// REKEY(k) = ENCRYPT(k, 2^64-1, empty, zeros)[0..<32]; the old key is wiped.
    public func rekey() throws {
        guard let k = keyStorage else { throw CryptoError.badKey }
        let out = SecureBytes(count: 48)
        Sodium.seal(into: out.ptr, SecureBytes(count: 32), ad: Data(), nonce: Self.nonce(Self.maxNonce), key: k, crypto_aead_chacha20poly1305_ietf_encrypt)
        k.wipe()
        keyStorage = SecureBytes(prefix: 32, of: out)
    }

    /// Wipes the key in place; the cipher is unusable afterwards.
    func wipeKey() {
        keyStorage?.wipe()
        keyStorage = nil
    }
}

final class SymmetricState {
    static let proto = "Noise_KK_25519_ChaChaPoly_BLAKE2b"
    private(set) var h: Data
    private(set) var ckStorage: SecureBytes
    // nil until the first DH: handshake payloads before that go in the clear, as Noise says
    private var cipher: CipherState?
    var cipherKeyStorage: SecureBytes? { cipher?.keyStorage }

    init() {
        // shorter than HASHLEN, so zero-padded rather than hashed
        var h = Data(Self.proto.utf8)
        h.append(Data(count: 64 - h.count))
        self.h = h
        ckStorage = SecureBytes(h)
    }

    func mixHash(_ data: Data) { h = Sodium.blake2b { $0(h); $0(data) }.data }

    /// Wipes ikm (always a DH output here) and the old chaining key and cipher key once mixed in.
    func mixKey(_ ikm: SecureBytes) {
        let (ck, k) = NoiseHKDF.hkdf(ck: ckStorage, ikm: ikm)
        ikm.wipe()
        ckStorage.wipe()
        ckStorage = ck
        cipher?.wipeKey()
        cipher = try! CipherState(key: SecureBytes(prefix: 32, of: k))
        k.wipe()
    }

    func encryptAndHash(_ pt: Data) throws -> Data {
        let ct = try cipher.map { try $0.encryptWithAd(h, pt) } ?? pt
        mixHash(ct)
        return ct
    }

    func decryptAndHash(_ ct: Data) throws -> Data {
        let pt = try cipher.map { try $0.decryptWithAd(h, ct) } ?? ct
        mixHash(ct)
        return pt
    }

    /// One shot: the two transport ciphers; the chaining key and handshake cipher are wiped.
    func split() -> (CipherState, CipherState) {
        let (a, b) = NoiseHKDF.hkdf(ck: ckStorage, ikm: nil)
        defer { a.wipe(); b.wipe() }
        ckStorage.wipe()
        cipher?.wipeKey()
        cipher = nil
        return (try! CipherState(key: SecureBytes(prefix: 32, of: a)), try! CipherState(key: SecureBytes(prefix: 32, of: b)))
    }
}

/// One Noise KK handshake. Not thread-safe: use from one place at a time.
public final class NoiseKK {
    let symmetric = SymmetricState()
    private let initiator: Bool
    private let s: KeyPair
    private let rs: Data
    private(set) var ephemeralStorage: Ephemeral?
    private var re: Data?
    private var step = 0
    private var failed = false
    private var didSplit = false

    /// `rs` is the other side's static public key, known from pairing.
    /// `testEphemeral` is for test vectors only: reusing one in a real session breaks forward secrecy.
    public init(initiator: Bool, s: KeyPair, rs: Data, prologue: Data, testEphemeral: KeyPair? = nil) throws {
        guard rs.count == 32 else { throw CryptoError.badKey }
        self.initiator = initiator
        self.s = s
        self.rs = rs
        ephemeralStorage = try testEphemeral.map { try Ephemeral(privateKey: SecureBytes($0.privateKey)) }
        symmetric.mixHash(prologue)
        symmetric.mixHash(initiator ? s.publicKey : rs)
        symmetric.mixHash(initiator ? rs : s.publicKey)
    }

    public var isDone: Bool { step == 2 }

    /// Same on both ends once done; usable as a channel binding.
    public func handshakeHash() throws -> Data {
        guard isDone else { throw CryptoError.notDone }
        return symmetric.h
    }

    private var myTurn: Bool { (step == 0) == initiator }

    private func check(writing: Bool) throws {
        if failed { throw CryptoError.handshakeFailed }
        if isDone { throw CryptoError.handshakeDone }
        if myTurn != writing { throw CryptoError.notYourTurn }
    }

    // es/ss for message 1, ee/se for message 2, from whichever side is running; mixKey wipes each DH output
    private func mixDh() throws {
        // the responder has no ephemeral yet while reading message 1, so look it up only where used
        let sp = s.privateKey
        func e() -> SecureBytes { ephemeralStorage!.privateKey }
        if step == 0 {
            symmetric.mixKey(initiator ? try X25519.dh(e(), rs) : try X25519.dh(sp, re!))
            symmetric.mixKey(try X25519.dh(sp, rs))
        } else {
            symmetric.mixKey(try X25519.dh(e(), re!))
            symmetric.mixKey(initiator ? try X25519.dh(sp, re!) : try X25519.dh(e(), rs))
        }
    }

    // the ephemeral private key is only needed until both DH steps that use it are done
    private func advance() {
        step += 1
        if isDone {
            ephemeralStorage?.privateKey.wipe()
            ephemeralStorage = nil
        }
    }

    /// Any failure ends the handshake: it can't continue in a half-mixed state.
    private func guarded<T>(_ f: () throws -> T) throws -> T {
        do { return try f() } catch {
            failed = true
            ephemeralStorage?.privateKey.wipe()
            throw error
        }
    }

    /// Throws on a bad remote key (the handshake is dead after that) or an oversized payload.
    public func writeMessage(_ payload: Data) throws -> Data {
        try check(writing: true)
        guard 32 + payload.count + 16 <= noiseMaxMessage else { throw CryptoError.badLength }
        return try guarded {
            if ephemeralStorage == nil { ephemeralStorage = .generate() }
            let pub = ephemeralStorage!.publicKey
            symmetric.mixHash(pub)
            try mixDh()
            let msg = pub + (try symmetric.encryptAndHash(payload))
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
            symmetric.mixHash(re!)
            try mixDh()
            let payload = try symmetric.decryptAndHash(Data(msg.dropFirst(32)))
            advance()
            return payload
        }
    }

    /// The transport ciphers for this side: send to the peer, receive from the peer. Only once: a second pair would reuse nonces.
    public func split() throws -> (send: CipherState, recv: CipherState) {
        guard isDone else { throw CryptoError.notDone }
        guard !didSplit else { throw CryptoError.alreadySplit }
        didSplit = true
        let (c1, c2) = symmetric.split()
        return initiator ? (c1, c2) : (c2, c1)
    }
}
