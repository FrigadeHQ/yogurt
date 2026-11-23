// XChaCha20-Poly1305 for the pairing exchange. A box is the 24-byte random nonce followed by the ciphertext.
import { sodium } from './sodium'

const NONCE = 24

export function sealBox(key: Uint8Array, plaintext: Uint8Array, ad: Uint8Array): Uint8Array {
  const s = sodium()
  const nonce = s.randombytes_buf(NONCE)
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, ad, null, nonce, key)
  const box = new Uint8Array(NONCE + ct.length)
  box.set(nonce)
  box.set(ct, NONCE)
  return box
}

/** Throws when the box was changed, or sealed under another key or associated data. */
export function openBox(key: Uint8Array, box: Uint8Array, ad: Uint8Array): Uint8Array {
  if (box.length < NONCE + 16) throw new Error('box: too short')
  try {
    return sodium().crypto_aead_xchacha20poly1305_ietf_decrypt(null, box.subarray(NONCE), ad, box.subarray(0, NONCE), key)
  } catch {
    throw new Error('box: could not open')
  }
}
