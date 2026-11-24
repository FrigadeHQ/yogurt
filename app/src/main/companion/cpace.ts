// CPace on ristretto255 + SHA-512, initiator/responder setting, exactly as draft-irtf-cfrg-cpace-21.
// The desktop is A (initiator), the phone is B (responder). YogurtKit's Cpace.swift mirrors this file.
import { hkdfSync } from 'node:crypto'
import { sodium } from './sodium'

const DSI = new TextEncoder().encode('CPaceRistretto255')
const DSI_ISK = new TextEncoder().encode('CPaceRistretto255_ISK')
const SHA512_BLOCK = 128
const EMPTY = new Uint8Array(0)

export interface CpaceSecret { scalar: Uint8Array; sid: Uint8Array; ya: Uint8Array; ada: Uint8Array }

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

/** LEB128 length, then the bytes (the draft's prepend_len). */
function prependLen(data: Uint8Array): Uint8Array {
  const len: number[] = []
  let n = data.length
  do { len.push((n & 0x7f) | (n >= 0x80 ? 0x80 : 0)); n >>>= 7 } while (n > 0)
  return concat(Uint8Array.from(len), data)
}

export function lvCat(...parts: Uint8Array[]): Uint8Array {
  return concat(...parts.map(prependLen))
}

export function generatorString(prs: string, ci: Uint8Array, sid: Uint8Array): Uint8Array {
  const p = new TextEncoder().encode(prs)
  // pads DSI and PRS out to a whole hash block, so hashing time doesn't depend on the code
  const zpad = Math.max(0, SHA512_BLOCK - prependLen(p).length - prependLen(DSI).length - 1)
  return lvCat(DSI, p, new Uint8Array(zpad), ci, sid)
}

/** The encoded generator g; scalar_mult takes the encoding, so there's no separate internal form here. */
export function cpaceGenerator(prs: string, ci: Uint8Array, sid: Uint8Array): Uint8Array {
  const s = sodium()
  return s.crypto_core_ristretto255_from_hash(s.crypto_hash_sha512(generatorString(prs, ci, sid)))
}

/** 32 random bytes with the bits above 252 cleared (the draft's recommended sampling). */
function sampleScalar(): Uint8Array {
  const y = sodium().randombytes_buf(32)
  y[31] &= 0x0f
  return y
}

/** scalar_mult_vfy: throws on an invalid encoding or the identity, which means abort. */
function scalarMultVfy(y: Uint8Array, x: Uint8Array): Uint8Array {
  if (x.length !== 32) throw new Error('cpace: bad point')
  try {
    return sodium().crypto_scalarmult_ristretto255(y, x)
  } catch {
    throw new Error('cpace: bad point')
  }
}

// wipes K and the hash input once the key is out (best effort: JS may keep copies)
function isk(sid: Uint8Array, k: Uint8Array, ya: Uint8Array, ada: Uint8Array, yb: Uint8Array, adb: Uint8Array): Uint8Array {
  const input = concat(lvCat(DSI_ISK, sid, k), lvCat(ya, ada), lvCat(yb, adb))
  try {
    return sodium().crypto_hash_sha512(input)
  } finally {
    k.fill(0)
    input.fill(0)
  }
}

/** Initiator, step 1: send `ya` (the public share Ya), keep `secret` for cpaceFinish. Never pass `testScalar` outside test vectors. */
export function cpaceStart(prs: string, ci: Uint8Array, sid: Uint8Array, ada = EMPTY, testScalar?: Uint8Array): { ya: Uint8Array; secret: CpaceSecret } {
  const scalar = testScalar ?? sampleScalar()
  try {
    const ya = sodium().crypto_scalarmult_ristretto255(scalar, cpaceGenerator(prs, ci, sid))
    return { ya, secret: { scalar, sid, ya, ada } }
  } catch (err) {
    scalar.fill(0)
    throw err
  }
}

/** Initiator, step 2: the 64-byte ISK from the responder's Yb. Single use: the scalar is wiped. */
export function cpaceFinish(secret: CpaceSecret, yb: Uint8Array, adb = EMPTY): Uint8Array {
  try {
    return isk(secret.sid, scalarMultVfy(secret.scalar, yb), secret.ya, secret.ada, yb, adb)
  } finally {
    secret.scalar.fill(0)
  }
}

/** Responder: answer the initiator's Ya with Yb and get the same ISK. Never pass `testScalar` outside test vectors. */
export function cpaceRespond(prs: string, ci: Uint8Array, sid: Uint8Array, ya: Uint8Array, ada = EMPTY, adb = EMPTY, testScalar?: Uint8Array): { yb: Uint8Array; isk: Uint8Array } {
  const scalar = testScalar ?? sampleScalar()
  try {
    const yb = sodium().crypto_scalarmult_ristretto255(scalar, cpaceGenerator(prs, ci, sid))
    return { yb, isk: isk(sid, scalarMultVfy(scalar, ya), ya, ada, yb, adb) }
  } finally {
    scalar.fill(0)
  }
}

const hkdf = (isk: Uint8Array, label: string) => new Uint8Array(hkdfSync('sha512', isk, EMPTY, label, 32))

/** The keys for the pairing boxes: HKDF-SHA-512, empty salt, 32 bytes each. */
export function pairKeys(isk: Uint8Array): { toPhone: Uint8Array; toDesktop: Uint8Array; confirm: Uint8Array } {
  return { toPhone: hkdf(isk, 'yogurt pair to-phone'), toDesktop: hkdf(isk, 'yogurt pair to-desktop'), confirm: hkdf(isk, 'yogurt pair confirm') }
}
