import Clibsodium
import Foundation

/// Every failure in YogurtKit's crypto; the cases say what went wrong, never which bytes.
public enum CryptoError: Error, Equatable {
    case badPoint, badKey, badLength, decrypt, handshakeFailed, handshakeDone, notYourTurn, notDone, alreadySplit, nonceExhausted, secretUsed
}

/// Secret bytes in one owned buffer, so a wipe zeroes the bytes the crypto actually used.
/// (Swift's Data is copy-on-write: wiping a Data can zero a fresh copy and leave the original.)
/// Not thread-safe: use from one place at a time.
final class SecureBytes {
    private let buf: UnsafeMutableRawBufferPointer
    let count: Int

    init(count: Int) {
        self.count = count
        // at least one byte, so the pointer is valid even for empty input
        buf = .allocate(byteCount: max(1, count), alignment: 16)
        buf.initializeMemory(as: UInt8.self, repeating: 0)
    }

    /// Copies `data` in; the caller's Data is theirs to manage.
    convenience init(_ data: Data) {
        self.init(count: data.count)
        data.withUnsafeBytes { if let b = $0.baseAddress { buf.baseAddress!.copyMemory(from: b, byteCount: data.count) } }
    }

    /// The first `count` bytes of `other`.
    convenience init(prefix count: Int, of other: SecureBytes) {
        precondition(count <= other.count)
        self.init(count: count)
        other.withBytes { buf.baseAddress!.copyMemory(from: $0, byteCount: count) }
    }

    static func random(_ n: Int) -> SecureBytes {
        _ = Sodium.ready
        let s = SecureBytes(count: n)
        randombytes_buf(s.buf.baseAddress!, n)
        return s
    }

    var ptr: UnsafeMutablePointer<UInt8> { buf.baseAddress!.assumingMemoryBound(to: UInt8.self) }

    func withBytes<R>(_ f: (UnsafePointer<UInt8>) throws -> R) rethrows -> R { try f(ptr) }

    subscript(i: Int) -> UInt8 {
        get { ptr[i] }
        set { ptr[i] = newValue }
    }

    /// A copy for values that leave the crypto (public shares, the ISK the caller asked for).
    var data: Data { Data(bytes: ptr, count: count) }

    var isZero: Bool { sodium_is_zero(ptr, count) == 1 }

    func wipe() { sodium_memzero(buf.baseAddress!, buf.count) }

    deinit {
        wipe()
        buf.deallocate()
    }
}

/// Something libsodium can read in place: public Data, or SecureBytes.
protocol Bytes {
    var count: Int { get }
    func withBytes<R>(_ f: (UnsafePointer<UInt8>) throws -> R) rethrows -> R
}

extension SecureBytes: Bytes {}

extension Data: Bytes {
    /// No copy; a valid pointer even when empty.
    func withBytes<R>(_ f: (UnsafePointer<UInt8>) throws -> R) rethrows -> R {
        try withUnsafeBytes { p in
            if let b = p.bindMemory(to: UInt8.self).baseAddress { return try f(b) }
            var zero: UInt8 = 0
            return try withUnsafePointer(to: &zero) { try f($0) }
        }
    }
}

/// Feeds parts into a streaming hash, so secrets are hashed where they live instead of concatenated into copies.
struct Feed {
    let update: (UnsafePointer<UInt8>, Int) -> Void
    func callAsFunction(_ b: some Bytes) { b.withBytes { update($0, b.count) } }
}

enum Sodium {
    // sodium_init is safe to call more than once; this runs it before any other call
    static let ready: Void = { precondition(sodium_init() >= 0, "libsodium failed to start") }()

    static func random(_ n: Int) -> Data { SecureBytes.random(n).data }

    static func sha512(_ body: (Feed) -> Void) -> SecureBytes {
        _ = ready
        var state = crypto_hash_sha512_state()
        defer { withUnsafeMutableBytes(of: &state) { sodium_memzero($0.baseAddress!, $0.count) } }
        precondition(crypto_hash_sha512_init(&state) == 0)
        body(Feed { p, n in precondition(crypto_hash_sha512_update(&state, p, UInt64(n)) == 0) })
        let out = SecureBytes(count: 64)
        precondition(crypto_hash_sha512_final(&state, out.ptr) == 0)
        return out
    }

    /// BLAKE2b-512, unkeyed.
    static func blake2b(_ body: (Feed) -> Void) -> SecureBytes {
        _ = ready
        // libsodium wants this state 64-byte aligned, which a Swift local doesn't promise
        let size = crypto_generichash_statebytes()
        let raw = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 64)
        defer { sodium_memzero(raw, size); raw.deallocate() }
        let state = OpaquePointer(raw) // the aligned struct comes into Swift as opaque
        precondition(crypto_generichash_init(state, nil, 0, 64) == 0)
        body(Feed { p, n in precondition(crypto_generichash_update(state, p, UInt64(n)) == 0) })
        let out = SecureBytes(count: 64)
        precondition(crypto_generichash_final(state, out.ptr, 64) == 0)
        return out
    }

    /// A 32-byte result from a two-input libsodium call, kept in owned storage; throws `error` when libsodium refuses.
    static func out32(_ a: some Bytes, _ b: some Bytes, error: CryptoError,
                      _ f: (UnsafeMutablePointer<UInt8>, UnsafePointer<UInt8>, UnsafePointer<UInt8>) -> Int32) throws -> SecureBytes {
        _ = ready
        let out = SecureBytes(count: 32)
        guard a.withBytes({ pa in b.withBytes { pb in f(out.ptr, pa, pb) } }) == 0 else { throw error }
        return out
    }

    typealias Encrypt = (UnsafeMutablePointer<UInt8>, UnsafeMutablePointer<UInt64>, UnsafePointer<UInt8>, UInt64, UnsafePointer<UInt8>, UInt64, UnsafePointer<UInt8>?, UnsafePointer<UInt8>, UnsafePointer<UInt8>) -> Int32
    typealias Decrypt = (UnsafeMutablePointer<UInt8>, UnsafeMutablePointer<UInt64>, UnsafeMutablePointer<UInt8>?, UnsafePointer<UInt8>, UInt64, UnsafePointer<UInt8>, UInt64, UnsafePointer<UInt8>, UnsafePointer<UInt8>) -> Int32

    /// AEAD encrypt (ciphertext || 16-byte tag) into `out`, which must hold pt.count + 16 bytes.
    static func seal(into out: UnsafeMutablePointer<UInt8>, _ pt: some Bytes, ad: some Bytes, nonce: some Bytes, key: some Bytes, _ f: Encrypt) {
        _ = ready
        var len: UInt64 = 0
        let rc = pt.withBytes { p in ad.withBytes { a in nonce.withBytes { n in key.withBytes { k in
            f(out, &len, p, UInt64(pt.count), a, UInt64(ad.count), nil, n, k)
        } } } }
        precondition(rc == 0, "AEAD encrypt failed")
    }

    static func seal(_ pt: some Bytes, ad: some Bytes, nonce: some Bytes, key: some Bytes, _ f: Encrypt) -> Data {
        var out = Data(count: pt.count + 16)
        out.withUnsafeMutableBytes { seal(into: $0.bindMemory(to: UInt8.self).baseAddress!, pt, ad: ad, nonce: nonce, key: key, f) }
        return out
    }

    static func open(_ ct: some Bytes, ad: some Bytes, nonce: some Bytes, key: some Bytes, _ f: Decrypt) throws -> Data {
        _ = ready
        guard ct.count >= 16 else { throw CryptoError.decrypt }
        // one spare byte so the pointer is valid for an empty plaintext
        var out = Data(count: ct.count - 16 + 1)
        var len: UInt64 = 0
        let rc = out.withUnsafeMutableBytes { o in ct.withBytes { c in ad.withBytes { a in nonce.withBytes { n in key.withBytes { k in
            f(o.bindMemory(to: UInt8.self).baseAddress!, &len, nil, c, UInt64(ct.count), a, UInt64(ad.count), n, k)
        } } } } }
        guard rc == 0 else { throw CryptoError.decrypt }
        return out.prefix(ct.count - 16)
    }
}

/// Wipes a Data in place. Only zeroes the original when nothing else shares its storage, so use it on
/// buffers this code made and never handed out; secrets that live on use SecureBytes.
func wipe(_ d: inout Data) {
    d.withUnsafeMutableBytes { if let b = $0.baseAddress { sodium_memzero(b, $0.count) } }
}
