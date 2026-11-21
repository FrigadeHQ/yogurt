import CryptoKit
import Foundation

/// The keys for the pairing boxes: HKDF-SHA-512, empty salt, 32 bytes each. Mirrors pairKeys() in app/src/main/companion/cpace.ts.
public struct PairKeys: Sendable {
    public let toPhone: Data
    public let toDesktop: Data
    public let confirm: Data

    public init(isk: Data) {
        func derive(_ label: String) -> Data {
            HKDF<SHA512>.deriveKey(inputKeyMaterial: SymmetricKey(data: isk), salt: Data(), info: Data(label.utf8), outputByteCount: 32)
                .withUnsafeBytes { Data($0) }
        }
        toPhone = derive("yogurt pair to-phone")
        toDesktop = derive("yogurt pair to-desktop")
        confirm = derive("yogurt pair confirm")
    }
}

/// Noise's HMAC and HKDF over BLAKE2b (spec §4.3): HMAC built from the plain hash, not BLAKE2b's keyed mode.
enum NoiseHKDF {
    static let blockLen = 128

    static func hmac(key: Data, data: Data) -> Data {
        var k = Data(count: blockLen)
        let key = key.count > blockLen ? Sodium.blake2b(key) : key
        k.replaceSubrange(0..<key.count, with: key)
        let pad = { (b: UInt8) in Data(k.map { $0 ^ b }) }
        return Sodium.blake2b(pad(0x5c) + Sodium.blake2b(pad(0x36) + data))
    }

    static func hkdf(ck: Data, ikm: Data) -> (Data, Data) {
        let temp = hmac(key: ck, data: ikm)
        let one = hmac(key: temp, data: Data([1]))
        return (one, hmac(key: temp, data: one + Data([2])))
    }
}
