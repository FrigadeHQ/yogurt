import Clibsodium
import Foundation

/// XChaCha20-Poly1305 for the pairing exchange: a box is the 24-byte random nonce followed by the ciphertext.
/// Mirrors app/src/main/companion/box.ts.
public enum Box {
    static let nonceLen = 24

    public static func seal(key: Data, plaintext: Data, ad: Data) throws -> Data {
        guard key.count == 32 else { throw CryptoError.badKey }
        let nonce = Sodium.random(nonceLen)
        return nonce + Sodium.seal(plaintext, ad: ad, nonce: nonce, key: key, crypto_aead_xchacha20poly1305_ietf_encrypt)
    }

    /// Throws when the box was changed, or sealed under another key or associated data.
    public static func open(key: Data, box: Data, ad: Data) throws -> Data {
        guard key.count == 32 else { throw CryptoError.badKey }
        guard box.count >= nonceLen + 16 else { throw CryptoError.badLength }
        return try Sodium.open(Data(box.dropFirst(nonceLen)), ad: ad, nonce: Data(box.prefix(nonceLen)), key: key, crypto_aead_xchacha20poly1305_ietf_decrypt)
    }
}
