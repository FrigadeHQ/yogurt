import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ready } from '../src/main/companion/sodium'
import { CipherState, NoiseKK, generateKeyPair, keyPairFromPrivate } from '../src/main/companion/noise'

const fixtures = JSON.parse(readFileSync(join(__dirname, '../../ios/Fixtures/noise-kk-vectors.json'), 'utf8'))
const lowOrder: string[] = JSON.parse(readFileSync(join(__dirname, '../../ios/Fixtures/noise-low-order-points.json'), 'utf8')).points
const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'))
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const utf8 = (s: string) => new TextEncoder().encode(s)
const prologue = utf8('yogurt-v1')

beforeAll(() => ready())

function handshake() {
  const { i, r } = pair()
  r.readMessage(i.writeMessage(new Uint8Array(0)))
  i.readMessage(r.writeMessage(new Uint8Array(0)))
  return { i, r }
}

function pair() {
  const a = generateKeyPair(), b = generateKeyPair()
  const i = new NoiseKK({ initiator: true, s: a, rs: b.publicKey, prologue })
  const r = new NoiseKK({ initiator: false, s: b, rs: a.publicKey, prologue })
  return { a, b, i, r }
}

describe('Noise_KK_25519_ChaChaPoly_BLAKE2b', () => {
  for (const v of fixtures.vectors) {
    it(`reproduces the ${v.source} vector`, () => {
      const i = new NoiseKK({
        initiator: true, s: keyPairFromPrivate(hex(v.init_static)), rs: hex(v.init_remote_static),
        prologue: hex(v.init_prologue), testEphemeral: keyPairFromPrivate(hex(v.init_ephemeral)),
      })
      const r = new NoiseKK({
        initiator: false, s: keyPairFromPrivate(hex(v.resp_static)), rs: hex(v.resp_remote_static),
        prologue: hex(v.resp_prologue), testEphemeral: keyPairFromPrivate(hex(v.resp_ephemeral)),
      })
      const [m0, m1, ...transport] = v.messages
      const c0 = i.writeMessage(hex(m0.payload))
      expect(toHex(c0)).toBe(m0.ciphertext)
      expect(toHex(r.readMessage(c0))).toBe(m0.payload)
      const c1 = r.writeMessage(hex(m1.payload))
      expect(toHex(c1)).toBe(m1.ciphertext)
      expect(toHex(i.readMessage(c1))).toBe(m1.payload)
      expect(i.done && r.done).toBe(true)
      if (v.handshake_hash) expect(toHex(i.handshakeHash)).toBe(v.handshake_hash)
      expect(toHex(r.handshakeHash)).toBe(toHex(i.handshakeHash))

      const si = i.split(), sr = r.split()
      transport.forEach((m: { payload: string; ciphertext: string }, n: number) => {
        const [send, recv] = n % 2 === 0 ? [si.send, sr.recv] : [sr.send, si.recv]
        const ct = send.encrypt(hex(m.payload))
        expect(toHex(ct)).toBe(m.ciphertext)
        expect(toHex(recv.decrypt(ct))).toBe(m.payload)
      })
    })
  }

  it('a fresh handshake carries payloads both ways and gives matching transport keys', () => {
    const { i, r } = pair()
    expect(new TextDecoder().decode(r.readMessage(i.writeMessage(utf8('hi'))))).toBe('hi')
    expect(i.done).toBe(false)
    expect(new TextDecoder().decode(i.readMessage(r.writeMessage(utf8('hey'))))).toBe('hey')
    const si = i.split(), sr = r.split()
    expect(new TextDecoder().decode(sr.recv.decrypt(si.send.encrypt(utf8('one'))))).toBe('one')
    expect(new TextDecoder().decode(si.recv.decrypt(sr.send.encrypt(utf8('two'))))).toBe('two')
  })

  it('throws on a tampered or replayed transport message', () => {
    const { i, r } = pair()
    r.readMessage(i.writeMessage(new Uint8Array(0)))
    i.readMessage(r.writeMessage(new Uint8Array(0)))
    const si = i.split(), sr = r.split()
    const ct = si.send.encrypt(utf8('secret'))
    const bad = ct.slice(); bad[0] ^= 1
    expect(() => sr.recv.decrypt(bad)).toThrow()
    // the failed message must not use up a nonce
    expect(new TextDecoder().decode(sr.recv.decrypt(ct))).toBe('secret')
    expect(() => sr.recv.decrypt(ct)).toThrow()
  })

  it('a responder that expects a different static key rejects the first message', () => {
    const { i } = pair()
    const stranger = generateKeyPair()
    const r = new NoiseKK({ initiator: false, s: generateKeyPair(), rs: stranger.publicKey, prologue })
    expect(() => r.readMessage(i.writeMessage(new Uint8Array(0)))).toThrow()
  })

  it('a different prologue fails the handshake', () => {
    const a = generateKeyPair(), b = generateKeyPair()
    const i = new NoiseKK({ initiator: true, s: a, rs: b.publicKey, prologue })
    const r = new NoiseKK({ initiator: false, s: b, rs: a.publicKey, prologue: utf8('yogurt-v2') })
    expect(() => r.readMessage(i.writeMessage(new Uint8Array(0)))).toThrow()
  })

  it('refuses out-of-turn calls and split before the handshake ends', () => {
    const { i, r } = pair()
    expect(() => r.writeMessage(new Uint8Array(0))).toThrow()
    expect(() => i.split()).toThrow()
    r.readMessage(i.writeMessage(new Uint8Array(0)))
    expect(() => i.writeMessage(new Uint8Array(0))).toThrow()
  })

  it('rekey changes the key the same way on both ends', () => {
    const k = crypto.getRandomValues(new Uint8Array(32))
    const a = new CipherState(k.slice()), b = new CipherState(k.slice())
    a.rekey(); b.rekey()
    expect(new TextDecoder().decode(b.decrypt(a.encrypt(utf8('after'))))).toBe('after')
    const c = new CipherState(k.slice()), d = new CipherState(k.slice())
    d.rekey()
    expect(() => c.decrypt(d.encrypt(utf8('x')))).toThrow()
  })

  it('generates X25519 key pairs', () => {
    const k = generateKeyPair()
    expect(k.publicKey.length).toBe(32)
    expect(toHex(keyPairFromPrivate(k.privateKey).publicKey)).toBe(toHex(k.publicKey))
  })

  it('split works once; a second split throws (it would reuse nonces)', () => {
    const { i, r } = handshake()
    const si = i.split(), sr = r.split()
    expect(() => i.split()).toThrow(/already split/)
    expect(() => r.split()).toThrow(/already split/)
    expect(new TextDecoder().decode(sr.recv.decrypt(si.send.encrypt(utf8('ok'))))).toBe('ok')
  })

  it('rejects every low-order ephemeral key, and the handshake stays dead', () => {
    for (const point of lowOrder) {
      for (const tamperFirst of [true, false]) {
        const { i, r } = pair()
        const m0 = i.writeMessage(new Uint8Array(0))
        if (tamperFirst) {
          const bad = m0.slice(); bad.set(hex(point), 0)
          expect(() => r.readMessage(bad)).toThrow()
          expect(() => r.readMessage(m0)).toThrow(/failed/)
        } else {
          r.readMessage(m0)
          const m1 = r.writeMessage(new Uint8Array(0)).slice(); m1.set(hex(point), 0)
          expect(() => i.readMessage(m1)).toThrow()
          expect(i.done).toBe(false)
        }
      }
    }
  })

  it('a failed writeMessage leaves the handshake dead', () => {
    const i = new NoiseKK({ initiator: true, s: generateKeyPair(), rs: hex(lowOrder[0]), prologue })
    expect(() => i.writeMessage(new Uint8Array(0))).toThrow()
    expect(() => i.writeMessage(new Uint8Array(0))).toThrow(/failed/)
  })

  it('transport ciphers need a 32-byte key', () => {
    expect(() => new CipherState(undefined as unknown as Uint8Array)).toThrow()
    expect(() => new CipherState(new Uint8Array(16))).toThrow()
  })

  it('enforces the 65535-byte Noise message limit', () => {
    const { i, r } = handshake()
    const si = i.split(), sr = r.split()
    expect(si.send.encrypt(new Uint8Array(65535 - 16)).length).toBe(65535)
    expect(() => si.send.encrypt(new Uint8Array(65535 - 15))).toThrow()
    expect(() => sr.recv.decrypt(new Uint8Array(65536))).toThrow()
    expect(() => i.writeMessage(new Uint8Array(0))).toThrow()
    const { i: i2 } = pair()
    expect(() => i2.writeMessage(new Uint8Array(65535 - 47))).toThrow()
  })

  it('gives the handshake hash only once done, as a copy', () => {
    const { i, r } = pair()
    expect(() => i.handshakeHash).toThrow()
    r.readMessage(i.writeMessage(new Uint8Array(0)))
    i.readMessage(r.writeMessage(new Uint8Array(0)))
    const h = i.handshakeHash
    h.fill(0)
    expect(toHex(i.handshakeHash)).toBe(toHex(r.handshakeHash))
    expect(toHex(i.handshakeHash)).not.toBe(toHex(h))
  })

  it('wipes the ephemeral private key once the handshake is done', () => {
    const a = generateKeyPair(), b = generateKeyPair(), ea = generateKeyPair(), eb = generateKeyPair()
    const i = new NoiseKK({ initiator: true, s: a, rs: b.publicKey, prologue, testEphemeral: ea })
    const r = new NoiseKK({ initiator: false, s: b, rs: a.publicKey, prologue, testEphemeral: eb })
    r.readMessage(i.writeMessage(new Uint8Array(0)))
    i.readMessage(r.writeMessage(new Uint8Array(0)))
    expect(ea.privateKey.every((x) => x === 0)).toBe(true)
    expect(eb.privateKey.every((x) => x === 0)).toBe(true)
    expect(a.privateKey.some((x) => x !== 0)).toBe(true)
  })
})
