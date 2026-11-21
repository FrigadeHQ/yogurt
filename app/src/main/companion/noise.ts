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
  const inner = k.map((x) => x ^ 0x36), outer = k.map((x) => x ^ 0x5c)
  const out = hash(concat(outer, hash(concat(inner, data))))
  for (const b of [k, inner, outer]) b.fill(0)
  return out
}

function hkdf(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = hmac(ck, ikm)
  const one = hmac(temp, Uint8Array.of(1))
  const two = hmac(temp, concat(one, Uint8Array.of(2)))
  temp.fill(0)
  return [one, two]
}

/** First 32 bytes as a new key; wipes the 64-byte HKDF output. */
function key32(out: Uint8Array): Uint8Array {
  const k = out.slice(0, 32)
  out.fill(0)
  return k
}

const dh = (kp: KeyPair, pub: Uint8Array) => sodium().crypto_scalarmult(kp.privateKey, pub)

// 4 zero bytes then the 64-bit counter, little-endian
function nonceBytes(n: bigint): Uint8Array {
  const out = new Uint8Array(12)
  new DataView(out.buffer).setBigUint64(4, n, true)
  return out
}

const MAX_NONCE = 2n ** 64n - 1n
const TAG = 16

/** A transport cipher. Always keyed: an unkeyed one would put plaintext on the wire. */
export class CipherState {
  private k: Uint8Array
  private n = 0n

  constructor(k: Uint8Array) {
    if (!(k instanceof Uint8Array) || k.length !== 32) throw new Error('noise: a cipher needs a 32-byte key')
    this.k = k
  }

  encryptWithAd(ad: Uint8Array, pt: Uint8Array): Uint8Array {
    if (pt.length + TAG > MAX_MESSAGE) throw new Error('noise: message too big')
    if (this.n >= MAX_NONCE) throw new Error('noise: nonce exhausted')
    const ct = sodium().crypto_aead_chacha20poly1305_ietf_encrypt(pt, ad, null, nonceBytes(this.n), this.k)
    this.n++
    return ct
  }

  /** Throws on a changed, replayed or out-of-order message; the counter only moves on success. */
  decryptWithAd(ad: Uint8Array, ct: Uint8Array): Uint8Array {
    if (ct.length > MAX_MESSAGE) throw new Error('noise: message too big')
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
    const out = sodium().crypto_aead_chacha20poly1305_ietf_encrypt(new Uint8Array(32), EMPTY, null, nonceBytes(MAX_NONCE), this.k)
    this.k.fill(0)
    this.k = key32(out)
  }

  /** Best-effort wipe of the key; the cipher is unusable afterwards. */
  wipe(): void { this.k.fill(0) }
}

class SymmetricState {
  h: Uint8Array
  private ck: Uint8Array
  // null until the first DH: handshake payloads before that go in the clear, as Noise says
  private cipher: CipherState | null = null

  constructor() {
    const name = new TextEncoder().encode(PROTOCOL)
    this.h = new Uint8Array(HASHLEN)
    this.h.set(name) // shorter than HASHLEN, so zero-padded rather than hashed
    this.ck = this.h.slice()
  }

  mixHash(data: Uint8Array): void { this.h = hash(concat(this.h, data)) }

  /** Wipes ikm (always a DH output here) once mixed in. */
  mixKey(ikm: Uint8Array): void {
    const [ck, k] = hkdf(this.ck, ikm)
    ikm.fill(0)
    this.ck.fill(0)
    this.ck = ck
    this.cipher?.wipe()
    this.cipher = new CipherState(key32(k))
  }

  encryptAndHash(pt: Uint8Array): Uint8Array {
    const ct = this.cipher ? this.cipher.encryptWithAd(this.h, pt) : pt
    this.mixHash(ct)
    return ct
  }

  decryptAndHash(ct: Uint8Array): Uint8Array {
    const pt = this.cipher ? this.cipher.decryptWithAd(this.h, ct) : ct
    this.mixHash(ct)
    return pt
  }

  /** One shot: wipes the chaining key and the handshake cipher. */
  split(): [CipherState, CipherState] {
    const [a, b] = hkdf(this.ck, EMPTY)
    this.ck.fill(0)
    this.cipher?.wipe()
    this.cipher = null
    return [new CipherState(key32(a)), new CipherState(key32(b))]
  }
}

export interface NoiseOptions {
  initiator: boolean
  s: KeyPair
  /** The other side's static public key, known from pairing. */
  rs: Uint8Array
  prologue: Uint8Array
  /** A fixed ephemeral key. Test vectors only: reusing one in a real session breaks forward secrecy. */
  testEphemeral?: KeyPair
}

export class NoiseKK {
  private readonly ss = new SymmetricState()
  private readonly o: NoiseOptions
  private e: KeyPair | undefined
  private re: Uint8Array | undefined
  private step = 0
  private failed = false
  private splitDone = false

  constructor(o: NoiseOptions) {
    if (o.rs.length !== 32) throw new Error('noise: bad remote key')
    this.o = o
    this.e = o.testEphemeral
    this.ss.mixHash(o.prologue)
    const [is, rs] = o.initiator ? [o.s.publicKey, o.rs] : [o.rs, o.s.publicKey]
    this.ss.mixHash(is)
    this.ss.mixHash(rs)
  }

  get done(): boolean { return this.step === 2 }

  /** Same on both ends once done; usable as a channel binding. A copy, and only once the handshake is done. */
  get handshakeHash(): Uint8Array {
    if (!this.done) throw new Error('noise: handshake not done')
    return this.ss.h.slice()
  }

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

  // the ephemeral private key is only needed until both DH steps that use it are done
  private advance(): void {
    this.step++
    if (this.done) this.e?.privateKey.fill(0)
  }

  /** Throws on a bad remote key or oversized payload; the handshake can't continue after that. */
  writeMessage(payload: Uint8Array): Uint8Array {
    this.check(true)
    if (32 + payload.length + 16 > MAX_MESSAGE) throw new Error('noise: payload too big')
    try {
      this.e ??= generateKeyPair()
      this.ss.mixHash(this.e.publicKey)
      this.mixDh()
      const msg = concat(this.e.publicKey, this.ss.encryptAndHash(payload))
      this.advance()
      return msg
    } catch (err) {
      this.failed = true
      throw err
    }
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
      this.advance()
      return payload
    } catch (err) {
      this.failed = true
      throw err
    }
  }

  /** The transport ciphers for this side: send to the peer, receive from the peer. Once only: a second pair would reuse nonces. */
  split(): { send: CipherState; recv: CipherState } {
    if (!this.done) throw new Error('noise: handshake not done')
    if (this.splitDone) throw new Error('noise: already split')
    this.splitDone = true
    const [c1, c2] = this.ss.split()
    return this.o.initiator ? { send: c1, recv: c2 } : { send: c2, recv: c1 }
  }
}
