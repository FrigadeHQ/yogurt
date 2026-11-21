import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../src/main/store'
import { ready } from '../src/main/companion/sodium'
import { generateKeyPair } from '../src/main/companion/noise'
import { createCompanion, type Companion, type CompanionDeps } from '../src/main/companion'
import type { Advert } from '../src/main/companion/advertise'
import { pairAsPhone, raw, session } from './helpers/companionClient'

beforeAll(() => ready())

const open: { c: Companion; dir: string }[] = []
afterEach(async () => {
  for (const { c, dir } of open.splice(0)) { await c.stop(); rmSync(dir, { recursive: true, force: true }) }
})

async function make(o: Partial<CompanionDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-pair-'))
  const store = openStore(':memory:')
  const adverts: (Advert | null)[] = []
  let clock = 1_000_000
  const lines: string[] = []
  const c = await createCompanion({
    store, userDataDir: dir, seal: (s) => 'sealed:' + Buffer.from(s).toString('hex'), open: (s) => Buffer.from(s.slice(7), 'hex').toString(),
    ask: async () => ({ answer: '', sources: [] }), importRecording: async () => {}, audioFiles: async () => [],
    deviceName: () => 'Test Mac', log: (...p) => lines.push(p.join(' ')), ops: { notesRewrite: () => {} },
    host: '127.0.0.1', now: () => clock, advertiser: { publish: (a) => adverts.push(a), stop: () => adverts.push(null) },
    ...o,
  })
  open.push({ c, dir })
  return { c, store, dir, adverts, lines, tick: (ms: number) => { clock += ms } }
}

const devices = (store: ReturnType<typeof openStore>) => store.db.prepare('SELECT id, name, public_key FROM companion_devices').all()

describe('companion pairing', () => {
  it('is off until pairing starts: no port, no advert, and a desktop id plus a sealed key on disk', async () => {
    const { c, adverts, dir } = await make()
    expect(c.port()).toBeNull()
    expect(adverts.filter(Boolean)).toEqual([])
    const saved = JSON.parse(readFileSync(join(dir, 'companion.json'), 'utf8'))
    expect(saved.id).toBe(c.desktopId)
    expect(saved.privateKey).toMatch(/^sealed:/)
    expect(c.status()).toEqual({ paired: null, pairing: null, connected: false, syncing: false })
  })

  it('pairs with the right code: the phone is stored, the advert says pairing=0 and the phone has the desktop key', async () => {
    const { c, store, adverts } = await make()
    const { code } = await c.startPairing()
    expect(code).toMatch(/^\d{6}$/)
    expect(adverts.at(-1)).toMatchObject({ txt: { v: '1', id: c.desktopId, name: 'Test Mac', pairing: '1' } })
    const phone = generateKeyPair()
    const r = await pairAsPhone(c.port()!, code, phone)
    expect(r.result).toEqual({ type: 'pairOk' })
    expect(Buffer.from(r.desktop!.key)).toEqual(Buffer.from(c.publicKey))
    expect(r.desktop!.id).toBe(c.desktopId)
    expect(devices(store)).toEqual([expect.objectContaining({ name: 'Test iPhone', public_key: Buffer.from(phone.publicKey).toString('base64') })])
    expect(adverts.at(-1)).toMatchObject({ txt: { pairing: '0' } })
    expect(c.status()).toMatchObject({ paired: { name: 'Test iPhone', lastSeen: null }, pairing: null })
    // pairing is closed now: another hello is refused
    expect((await pairAsPhone(c.port()!, code, generateKeyPair())).result).toEqual({ type: 'pairFail', reason: 'expired' })
  })

  it('a wrong code fails and counts; five wrong codes give tooMany and a fresh code', async () => {
    const { c, store } = await make()
    const { code } = await c.startPairing()
    const wrong = code === '000000' ? '000001' : '000000'
    for (let i = 1; i <= 4; i++) {
      expect((await pairAsPhone(c.port()!, wrong, generateKeyPair())).result).toEqual({ type: 'pairFail', reason: 'code' })
      expect(c.status().pairing).toMatchObject({ code, attemptsLeft: 5 - i })
    }
    expect((await pairAsPhone(c.port()!, wrong, generateKeyPair())).result).toEqual({ type: 'pairFail', reason: 'tooMany' })
    const fresh = c.status().pairing!
    expect(fresh.attemptsLeft).toBe(5)
    expect(devices(store)).toEqual([])
    // the old code is no good any more; the new one is
    if (fresh.code !== code) expect((await pairAsPhone(c.port()!, code, generateKeyPair())).result).toMatchObject({ type: 'pairFail' })
    expect((await pairAsPhone(c.port()!, c.status().pairing!.code, generateKeyPair())).result).toEqual({ type: 'pairOk' })
  })

  it('a phone that breaks off after its guess still uses up an attempt', async () => {
    const { c } = await make()
    await c.startPairing()
    const s = await raw(c.port()!)
    s.sendJson({ type: 'pairHello', v: 1, phoneSession: Buffer.alloc(16, 1).toString('base64'), phoneName: 'x' })
    await s.json()
    // any valid point: its own share with a guessed code
    const { cpaceRespond } = await import('../src/main/companion/cpace')
    const { yb } = cpaceRespond('123456', new Uint8Array(1), new Uint8Array(1), (await import('../src/main/companion/cpace')).cpaceStart('1', new Uint8Array(1), new Uint8Array(1)).ya)
    s.sendJson({ type: 'pairReply', yb: Buffer.from(yb).toString('base64') })
    expect((await s.json()).type).toBe('pairConfirm')
    s.socket.destroy()
    await expect.poll(() => c.status().pairing?.attemptsLeft).toBe(4)
  })

  it('the code expires after two minutes', async () => {
    const { c, adverts, tick } = await make()
    const { code, expiresAt } = await c.startPairing()
    expect(expiresAt).toBe(1_000_000 + 120_000)
    tick(120_000)
    expect(c.status().pairing).toBeNull()
    await expect.poll(() => adverts.at(-1)).toBeNull()
    // not paired, so the server is off
    await expect.poll(() => c.port()).toBeNull()
    // pairing again opens it once more, with a fresh window
    const again = await c.startPairing()
    expect(again.code).toMatch(/^\d{6}$/)
    tick(119_000)
    expect(c.status().pairing?.code).toBe(again.code)
    void code
  })

  it('a second pairing replaces the first phone, and the old phone can no longer connect', async () => {
    const { c, store } = await make()
    const a = generateKeyPair(), b = generateKeyPair()
    const first = await c.startPairing()
    const ra = await pairAsPhone(c.port()!, first.code, a, 'Phone A')
    expect(ra.result.type).toBe('pairOk')
    const sa = await session(c.port()!, a, ra.desktop!.key)
    expect((await sa.request('hello', { appVersion: '1', schema: 1 })).type).toBe('ok')
    const { code } = await c.startPairing()
    expect((await pairAsPhone(c.port()!, code, b, 'Phone B')).result.type).toBe('pairOk')
    await sa.raw.closed
    expect(devices(store).map((d) => d.name)).toEqual(['Phone B'])
    // A's key is not the paired one now
    await expect(session(c.port()!, a, ra.desktop!.key)).rejects.toThrow()
    const sb = await session(c.port()!, b, ra.desktop!.key)
    expect((await sb.request('hello', { appVersion: '1', schema: 1 })).type).toBe('ok')
    sb.close()
  })

  it('keeps its id and key across restarts, starts by itself when paired, and unpair turns it off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companion-pair-'))
    const store = openStore(':memory:')
    const base = {
      store, userDataDir: dir, seal: (s: string) => 'sealed:' + s, open: (s: string) => s.slice(7),
      ask: async () => ({ answer: '', sources: [] }), importRecording: async () => {}, audioFiles: async () => [],
      deviceName: () => 'Test Mac', log: () => {}, ops: { notesRewrite: () => {} }, host: '127.0.0.1', advertiser: { publish: () => {}, stop: () => {} },
    }
    const one = await createCompanion(base)
    const { code } = await one.startPairing()
    const phone = generateKeyPair()
    const r = await pairAsPhone(one.port()!, code, phone)
    const port = one.port()
    await one.stop()
    const two = await createCompanion(base)
    open.push({ c: two, dir })
    expect(two.desktopId).toBe(one.desktopId)
    expect(two.port()).toBe(port)
    const s = await session(two.port()!, phone, r.desktop!.key)
    expect((await s.request('hello', { appVersion: '1', schema: 1 })).type).toBe('ok')
    await two.unpair()
    await s.raw.closed
    expect(two.port()).toBeNull()
    expect(two.status().paired).toBeNull()
  })
})
