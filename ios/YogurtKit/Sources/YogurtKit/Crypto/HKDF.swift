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
/// Every intermediate is SecureBytes, wiped when it goes out of scope.
enum NoiseHKDF {
    static let blockLen = 128

    static func hmac(key: SecureBytes, _ data: (Feed) -> Void) -> SecureBytes {
        let k = SecureBytes(count: blockLen)
        let short = key.count > blockLen ? Sodium.blake2b { $0(key) } : key
        short.withBytes { k.ptr.update(from: $0, count: short.count) }
        let inner = SecureBytes(count: blockLen), outer = SecureBytes(count: blockLen)
        for i in 0..<blockLen { inner[i] = k[i] ^ 0x36; outer[i] = k[i] ^ 0x5c }
        let ih = Sodium.blake2b { $0(inner); data($0) }
        return Sodium.blake2b { $0(outer); $0(ih) }
    }

    /// The two 64-byte outputs; `ikm` nil means empty (Split).
    static func hkdf(ck: SecureBytes, ikm: SecureBytes?) -> (SecureBytes, SecureBytes) {
        let temp = hmac(key: ck) { if let ikm { $0(ikm) } }
        let one = hmac(key: temp) { $0(Data([1])) }
        let two = hmac(key: temp) { $0(one); $0(Data([2])) }
        return (one, two)
    }
}
