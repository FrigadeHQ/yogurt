import Clibsodium
import Foundation

/// An X25519 key pair (the Noise static keys). The private key is plain Data because the app stores it
/// (Keychain); per-session ephemerals use `Ephemeral`, which can be wiped.
public struct KeyPair: Sendable {
    public let publicKey: Data
    public let privateKey: Data

    public init(privateKey: Data) throws {
        guard privateKey.count == 32 else { throw CryptoError.badKey }
        publicKey = try X25519.publicKey(privateKey)
        self.privateKey = privateKey
    }

    public static func generate() -> KeyPair {
        // a random 32-byte private key always has a public key (clamping happens inside)
        try! KeyPair(privateKey: Sodium.random(32))
    }
}

/// A Noise ephemeral key whose private half lives in owned storage, wiped once the handshake no longer needs it.
final class Ephemeral {
    let publicKey: Data
    let privateKey: SecureBytes

    init(privateKey: SecureBytes) throws {
        self.privateKey = privateKey
        publicKey = try X25519.publicKey(privateKey)
    }

    static func generate() -> Ephemeral { try! Ephemeral(privateKey: .random(32)) }
}

enum X25519 {
    static func publicKey(_ priv: some Bytes) throws -> Data {
        guard priv.count == 32 else { throw CryptoError.badKey }
        return try Sodium.out32(priv, Data(), error: .badKey) { o, p, _ in crypto_scalarmult_base(o, p) }.data
    }

    /// Throws on a low-order public key, whose result would be all zeros.
    static func dh(_ priv: some Bytes, _ pub: Data) throws -> SecureBytes {
        guard pub.count == 32, priv.count == 32 else { throw CryptoError.badPoint }
        return try Sodium.out32(priv, pub, error: .badPoint, crypto_scalarmult)
    }
}
