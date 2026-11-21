import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ready } from '../src/main/companion/sodium'
import { cpaceFinish, cpaceGenerator, cpaceRespond, cpaceStart, generatorString, lvCat, pairKeys } from '../src/main/companion/cpace'
import { openBox, sealBox } from '../src/main/companion/box'

const fixtures = JSON.parse(readFileSync(join(__dirname, '../../ios/Fixtures/cpace-ristretto255-vectors.json'), 'utf8'))
const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'))
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const utf8 = (s: string) => new TextEncoder().encode(s)
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n))

beforeAll(() => ready())

describe('CPace ristretto255 / SHA-512', () => {
  it('lv_cat matches the draft', () => {
    expect(toHex(lvCat(utf8('1234'), utf8('5'), new Uint8Array(0), utf8('678')))).toBe('043132333401350003363738')
    expect(toHex(lvCat(new Uint8Array(128))).slice(0, 4)).toBe('8001')
  })

  for (const v of fixtures.vectors) {
    const prs = Buffer.from(v.PRS, 'hex').toString('utf8')
    it(`${v.name}: generator`, () => {
      expect(toHex(generatorString(prs, hex(v.CI), hex(v.sid)))).toBe(v.generatorString)
      expect(toHex(cpaceGenerator(prs, hex(v.CI), hex(v.sid)))).toBe(v.g)
    })

    it(`${v.name}: Ya, Yb and the initiator/responder ISK`, () => {
      const a = cpaceStart(prs, hex(v.CI), hex(v.sid), hex(v.ADa), hex(v.ya))
      expect(toHex(a.ya)).toBe(v.Ya)
      const b = cpaceRespond(prs, hex(v.CI), hex(v.sid), a.ya, hex(v.ADa), hex(v.ADb), hex(v.yb))
      expect(toHex(b.yb)).toBe(v.Yb)
      expect(toHex(b.isk)).toBe(v.ISK_IR)
      expect(toHex(cpaceFinish(a.secret, b.yb, hex(v.ADb)))).toBe(v.ISK_IR)
    })
  }

  it('random runs agree, and a wrong code gives a different key', () => {
    const ci = utf8('yogurt-pair-v1'), sid = random(16)
    const a = cpaceStart('123456', ci, sid)
    const b = cpaceRespond('123456', ci, sid, a.ya)
    const isk = cpaceFinish(a.secret, b.yb)
    expect(isk.length).toBe(64)
    expect(toHex(isk)).toBe(toHex(b.isk))

    const a2 = cpaceStart('123456', ci, sid)
    const wrong = cpaceRespond('123457', ci, sid, a2.ya)
    expect(toHex(cpaceFinish(a2.secret, wrong.yb))).not.toBe(toHex(wrong.isk))
  })

  it('a different channel id or session id gives a different key', () => {
    const sid = random(16)
    const a = cpaceStart('123456', utf8('yogurt-pair-v1A'), sid)
    const b = cpaceRespond('123456', utf8('yogurt-pair-v1B'), sid, a.ya)
    expect(toHex(cpaceFinish(a.secret, b.yb))).not.toBe(toHex(b.isk))
    const c = cpaceStart('123456', utf8('ci'), sid)
    const d = cpaceRespond('123456', utf8('ci'), random(16), c.ya)
    expect(toHex(cpaceFinish(c.secret, d.yb))).not.toBe(toHex(d.isk))
  })

  it('rejects the identity and invalid encodings from either side', () => {
    const ci = utf8('ci'), sid = random(16)
    for (const bad of fixtures.invalidPoints) {
      expect(() => cpaceRespond('123456', ci, sid, hex(bad))).toThrow()
      const a = cpaceStart('123456', ci, sid)
      expect(() => cpaceFinish(a.secret, hex(bad))).toThrow()
    }
    expect(() => cpaceFinish(cpaceStart('1', ci, sid).secret, new Uint8Array(31))).toThrow()
  })

  it('wipes the scalar when cpaceStart fails', () => {
    const scalar = new Uint8Array(31).fill(7)
    expect(() => cpaceStart('1', utf8('ci'), random(16), undefined, scalar)).toThrow()
    expect(scalar.every((x) => x === 0)).toBe(true)
  })

  it('a used secret cannot give a second key', () => {
    const ci = utf8('ci'), sid = random(16)
    const a = cpaceStart('123456', ci, sid)
    const b = cpaceRespond('123456', ci, sid, a.ya)
    cpaceFinish(a.secret, b.yb)
    expect(() => cpaceFinish(a.secret, b.yb)).toThrow()
  })

  it('samples scalars below 2^252', () => {
    for (let i = 0; i < 20; i++) expect(cpaceStart('1', utf8('ci'), random(16)).secret.scalar[31]).toBeLessThan(0x10)
  })
})

describe('pairing keys and boxes', () => {
  it('derives three different 32-byte keys, the same on both sides', () => {
    const isk = random(64)
    const k = pairKeys(isk)
    for (const key of [k.toPhone, k.toDesktop, k.confirm]) expect(key.length).toBe(32)
    expect(new Set([k.toPhone, k.toDesktop, k.confirm].map(toHex)).size).toBe(3)
    expect(toHex(pairKeys(isk.slice()).toPhone)).toBe(toHex(k.toPhone))
    expect(toHex(pairKeys(random(64)).toPhone)).not.toBe(toHex(k.toPhone))
  })

  it('matches HKDF-SHA-512 with an empty salt (what the phone computes)', async () => {
    const { hkdfSync } = await import('node:crypto')
    const isk = random(64)
    expect(toHex(pairKeys(isk).toDesktop)).toBe(Buffer.from(hkdfSync('sha512', isk, new Uint8Array(0), 'yogurt pair to-desktop', 32)).toString('hex'))
  })

  it('seals and opens; a changed byte, key or associated data fails', () => {
    const key = random(32), ad = utf8('pairConfirm')
    const box = sealBox(key, utf8('hello'), ad)
    expect(box.length).toBe(24 + 5 + 16)
    expect(new TextDecoder().decode(openBox(key, box, ad))).toBe('hello')
    const tampered = box.slice(); tampered[30] ^= 1
    expect(() => openBox(key, tampered, ad)).toThrow()
    expect(() => openBox(random(32), box, ad)).toThrow()
    expect(() => openBox(key, box, utf8('pairDone'))).toThrow()
    expect(() => openBox(key, box.slice(0, 20), ad)).toThrow()
    expect(toHex(sealBox(key, utf8('hello'), ad))).not.toBe(toHex(box))
  })
})
