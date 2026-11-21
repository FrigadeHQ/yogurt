// Noise_KK_25519_ChaChaPoly_BLAKE2b (Noise spec rev 34). Both static keys are known from pairing:
//   -> s  <- s  ...  -> e, es, ss  <- e, ee, se
// YogurtKit's Noise.swift mirrors this file.
import { sodium } from './sodium'

const PROTOCOL = 'Noise_KK_25519_ChaChaPoly_BLAKE2b'
const HASHLEN = 64
const BLOCKLEN = 128
const MAX_MESSAGE = 65535
const EMPTY = new Uint8Array(0)

export interface KeyPair { publicKey: Uint8Array; privateKey: Uint8Array }

export function keyPairFromPrivate(privateKey: Uint8Array): KeyPair {
  return { publicKey: sodium().crypto_scalarmult_base(privateKey), privateKey }
}

export function generateKeyPair(): KeyPair {
  return keyPairFromPrivate(sodium().randombytes_buf(32))
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

const hash = (data: Uint8Array) => sodium().crypto_generichash(HASHLEN, data, null)

// HMAC built from plain BLAKE2b as the spec says (§4.3), not BLAKE2b's own keyed mode
function hmac(key: Uint8Array, data: Uint8Array): Uint8Array {
  const k = new Uint8Array(BLOCKLEN)
  k.set(key.length > BLOCKLEN ? hash(key) : key)
  const pad = (b: number) => k.map((x) => x ^ b)
  return hash(concat(pad(0x5c), hash(concat(pad(0x36), data))))
}

function hkdf(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = hmac(ck, ikm)
  const one = hmac(temp, Uint8Array.of(1))
  return [one, hmac(temp, concat(one, Uint8Array.of(2)))]
}

const dh = (kp: KeyPair, pub: Uint8Array) => sodium().crypto_scalarmult(kp.privateKey, pub)

// 4 zero bytes then the 64-bit counter, little-endian
function nonceBytes(n: bigint): Uint8Array {
  const out = new Uint8Array(12)
  new DataView(out.buffer).setBigUint64(4, n, true)
  return out
}

const MAX_NONCE = 2n ** 64n - 1n

export class CipherState {
  private k: Uint8Array | null
  private n = 0n

  constructor(k: Uint8Array | null = null) { this.k = k }

  get hasKey(): boolean { return this.k !== null }

  encryptWithAd(ad: Uint8Array, pt: Uint8Array): Uint8Array {
    if (!this.k) return pt
    if (this.n >= MAX_NONCE) throw new Error('noise: nonce exhausted')
    const ct = sodium().crypto_aead_chacha20poly1305_ietf_encrypt(pt, ad, null, nonceBytes(this.n), this.k)
    this.n++
    return ct
  }

  /** Throws on a changed, replayed or out-of-order message; the counter only moves on success. */
  decryptWithAd(ad: Uint8Array, ct: Uint8Array): Uint8Array {
    if (!this.k) return ct
    if (this.n >= MAX_NONCE) throw new Error('noise: nonce exhausted')
    let pt: Uint8Array
    try {
      pt = sodium().crypto_aead_chacha20poly1305_ietf_decrypt(null, ct, ad, nonceBytes(this.n), this.k)
    } catch {
      throw new Error('noise: could not decrypt')
    }
    this.n++
    return pt
  }

  encrypt(pt: Uint8Array): Uint8Array { return this.encryptWithAd(EMPTY, pt) }
  decrypt(ct: Uint8Array): Uint8Array { return this.decryptWithAd(EMPTY, ct) }

  rekey(): void {
    if (!this.k) throw new Error('noise: no key')
    const k = sodium().crypto_aead_chacha20poly1305_ietf_encrypt(new Uint8Array(32), EMPTY, null, nonceBytes(MAX_NONCE), this.k)
    this.k = k.subarray(0, 32)
  }
}

class SymmetricState {
  h: Uint8Array
  private ck: Uint8Array
  private cipher = new CipherState()

  constructor() {
    const name = new TextEncoder().encode(PROTOCOL)
    this.h = new Uint8Array(HASHLEN)
    this.h.set(name) // shorter than HASHLEN, so zero-padded rather than hashed
    this.ck = this.h.slice()
  }

  mixHash(data: Uint8Array): void { this.h = hash(concat(this.h, data)) }

  mixKey(ikm: Uint8Array): void {
    const [ck, k] = hkdf(this.ck, ikm)
    this.ck = ck
    this.cipher = new CipherState(k.slice(0, 32))
  }

  encryptAndHash(pt: Uint8Array): Uint8Array {
    const ct = this.cipher.encryptWithAd(this.h, pt)
    this.mixHash(ct)
    return ct
  }

  decryptAndHash(ct: Uint8Array): Uint8Array {
    const pt = this.cipher.decryptWithAd(this.h, ct)
    this.mixHash(ct)
    return pt
  }

  split(): [CipherState, CipherState] {
    const [a, b] = hkdf(this.ck, EMPTY)
    return [new CipherState(a.slice(0, 32)), new CipherState(b.slice(0, 32))]
  }
}

export interface NoiseOptions {
  initiator: boolean
  s: KeyPair
  /** The other side's static public key, known from pairing. */
  rs: Uint8Array
  prologue: Uint8Array
  /** A fixed ephemeral key, for test vectors only. */
  e?: KeyPair
}

export class NoiseKK {
  private readonly ss = new SymmetricState()
  private readonly o: NoiseOptions
  private e: KeyPair | undefined
  private re: Uint8Array | undefined
  private step = 0
  private failed = false

  constructor(o: NoiseOptions) {
    if (o.rs.length !== 32) throw new Error('noise: bad remote key')
    this.o = o
    this.e = o.e
    this.ss.mixHash(o.prologue)
    const [is, rs] = o.initiator ? [o.s.publicKey, o.rs] : [o.rs, o.s.publicKey]
    this.ss.mixHash(is)
    this.ss.mixHash(rs)
  }

  get done(): boolean { return this.step === 2 }

  /** Same on both ends once done; usable as a channel binding. */
  get handshakeHash(): Uint8Array { return this.ss.h }

  private myTurn(): boolean { return (this.step === 0) === this.o.initiator }

  private check(writing: boolean): void {
    if (this.failed) throw new Error('noise: handshake failed')
    if (this.done) throw new Error('noise: handshake already done')
    if (this.myTurn() !== writing) throw new Error('noise: not this side\'s turn')
  }

  // es/ss for message 1, ee/se for message 2, from whichever side is running
  private mixDh(): void {
    const { s, rs, initiator } = this.o
    const e = this.e!, re = this.re!
    if (this.step === 0) {
      this.ss.mixKey(initiator ? dh(e, rs) : dh(s, re))
      this.ss.mixKey(dh(s, rs))
    } else {
      this.ss.mixKey(dh(e, re))
      this.ss.mixKey(initiator ? dh(s, re) : dh(e, rs))
    }
  }

  writeMessage(payload: Uint8Array): Uint8Array {
    this.check(true)
    if (32 + payload.length + 16 > MAX_MESSAGE) throw new Error('noise: payload too big')
    this.e ??= generateKeyPair()
    this.ss.mixHash(this.e.publicKey)
    this.mixDh()
    const msg = concat(this.e.publicKey, this.ss.encryptAndHash(payload))
    this.step++
    return msg
  }

  /** Throws when the message wasn't made by the expected peer; the handshake can't continue after that. */
  readMessage(msg: Uint8Array): Uint8Array {
    this.check(false)
    try {
      if (msg.length < 32 + 16 || msg.length > MAX_MESSAGE) throw new Error('noise: bad message length')
      this.re = msg.slice(0, 32)
      this.ss.mixHash(this.re)
      this.mixDh()
      const payload = this.ss.decryptAndHash(msg.subarray(32))
      this.step++
      return payload
    } catch (err) {
      this.failed = true
      throw err
    }
  }

  /** The transport ciphers for this side: send to the peer, receive from the peer. */
  split(): { send: CipherState; recv: CipherState } {
    if (!this.done) throw new Error('noise: handshake not done')
    const [c1, c2] = this.ss.split()
    return this.o.initiator ? { send: c1, recv: c2 } : { send: c2, recv: c1 }
  }
}
