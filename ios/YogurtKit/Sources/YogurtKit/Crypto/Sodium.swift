import Clibsodium
import Foundation

/// Every failure in YogurtKit's crypto; the cases say what went wrong, never which bytes.
public enum CryptoError: Error, Equatable {
    case badPoint, badKey, badLength, decrypt, handshakeFailed, handshakeDone, notYourTurn, notDone, alreadySplit, nonceExhausted, secretUsed
}

// Calls go through [UInt8]: array-to-pointer conversion always yields a valid pointer, even for empty input.
enum Sodium {
    // sodium_init is safe to call more than once; this runs it before any other call
    static let ready: Void = { precondition(sodium_init() >= 0, "libsodium failed to start") }()

    static func random(_ n: Int) -> Data {
        _ = ready
        var out = [UInt8](repeating: 0, count: n)
        randombytes_buf(&out, n)
        return Data(out)
    }

    static func sha512(_ data: Data) -> Data {
        _ = ready
        var out = [UInt8](repeating: 0, count: 64)
        _ = crypto_hash_sha512(&out, [UInt8](data), UInt64(data.count))
        return Data(out)
    }

    /// BLAKE2b-512, unkeyed.
    static func blake2b(_ data: Data) -> Data {
        _ = ready
        var out = [UInt8](repeating: 0, count: 64)
        _ = crypto_generichash(&out, 64, [UInt8](data), UInt64(data.count), nil, 0)
        return Data(out)
    }

    /// A 32-byte result from a two-input libsodium call; throws `error` when libsodium refuses.
    static func out32(_ a: Data, _ b: Data, error: CryptoError, _ f: (UnsafeMutablePointer<UInt8>, UnsafePointer<UInt8>, UnsafePointer<UInt8>) -> Int32) throws -> Data {
        _ = ready
        var out = [UInt8](repeating: 0, count: 32)
        guard f(&out, [UInt8](a), [UInt8](b)) == 0 else { throw error }
        return Data(out)
    }

    /// AEAD encrypt (ciphertext || 16-byte tag) with a ChaCha20-Poly1305 flavour picked by `f`.
    static func seal(_ pt: Data, ad: Data, nonce: Data, key: Data,
                     _ f: (UnsafeMutablePointer<UInt8>, UnsafeMutablePointer<UInt64>, UnsafePointer<UInt8>, UInt64, UnsafePointer<UInt8>, UInt64, UnsafePointer<UInt8>?, UnsafePointer<UInt8>, UnsafePointer<UInt8>) -> Int32) -> Data {
        _ = ready
        var out = [UInt8](repeating: 0, count: pt.count + 16)
        var len: UInt64 = 0
        _ = f(&out, &len, [UInt8](pt), UInt64(pt.count), [UInt8](ad), UInt64(ad.count), nil, [UInt8](nonce), [UInt8](key))
        return Data(out)
    }

    static func open(_ ct: Data, ad: Data, nonce: Data, key: Data,
                     _ f: (UnsafeMutablePointer<UInt8>, UnsafeMutablePointer<UInt64>, UnsafeMutablePointer<UInt8>?, UnsafePointer<UInt8>, UInt64, UnsafePointer<UInt8>, UInt64, UnsafePointer<UInt8>, UnsafePointer<UInt8>) -> Int32) throws -> Data {
        _ = ready
        guard ct.count >= 16 else { throw CryptoError.decrypt }
        var out = [UInt8](repeating: 0, count: ct.count - 16)
        var len: UInt64 = 0
        guard f(&out, &len, nil, [UInt8](ct), UInt64(ct.count), [UInt8](ad), UInt64(ad.count), [UInt8](nonce), [UInt8](key)) == 0 else { throw CryptoError.decrypt }
        return Data(out)
    }
}

/// Wipes a buffer in place in a way the compiler won't drop.
func wipe(_ d: inout Data) {
    d.withUnsafeMutableBytes { if let b = $0.baseAddress { sodium_memzero(b, $0.count) } }
}
