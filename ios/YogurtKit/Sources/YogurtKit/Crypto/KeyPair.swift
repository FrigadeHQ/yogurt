import Clibsodium
import Foundation

/// An X25519 key pair (the Noise static and ephemeral keys).
public struct KeyPair: Sendable {
    public let publicKey: Data
    public let privateKey: Data

    public init(privateKey: Data) throws {
        guard privateKey.count == 32 else { throw CryptoError.badKey }
        _ = Sodium.ready
        var pub = [UInt8](repeating: 0, count: 32)
        guard crypto_scalarmult_base(&pub, [UInt8](privateKey)) == 0 else { throw CryptoError.badKey }
        self.publicKey = Data(pub)
        self.privateKey = privateKey
    }

    public static func generate() -> KeyPair {
        // a random 32-byte private key always has a public key (clamping happens inside)
        try! KeyPair(privateKey: Sodium.random(32))
    }

    /// X25519; throws on a low-order public key, whose result would be all zeros.
    func dh(_ pub: Data) throws -> Data {
        guard pub.count == 32 else { throw CryptoError.badPoint }
        return try Sodium.out32(privateKey, pub, error: .badPoint, crypto_scalarmult)
    }
}
