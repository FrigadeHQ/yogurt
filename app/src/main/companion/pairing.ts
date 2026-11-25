// Pairing over one connection, before any Noise session (the desktop is CPace initiator A):
//   pairHello {v:1, phoneSession, phoneName} → pairStart {v:1, desktopSession, desktopId, ya}
//   → pairReply {yb} → pairConfirm {box} → pairDone {box} → pairOk {} | pairFail {reason: code | expired | tooMany | busy}
// sid = desktopSession ‖ phoneSession, CI = "yogurt-pair-v1" ‖ desktopSession ‖ phoneSession, no AD. The boxes are
// XChaCha20-Poly1305 under pairKeys(ISK) (toPhone, AD "pairConfirm"; toDesktop, AD "pairDone") holding JSON
// {key, name, id}; opening one is the key confirmation. Binary fields are base64. Every frame has a "type".
import { randomInt } from 'node:crypto'
import { cpaceFinish, cpaceStart, pairKeys } from './cpace'
import { openBox, sealBox } from './box'
import { parseJson } from './frames'
import { sodium } from './sodium'

/** How long a code works, and how many wrong tries it takes before a new one */
export const PAIR_MS = 2 * 60 * 1000
export const ATTEMPTS = 5

/** busy: another phone is mid-exchange, or a wrong guess was just made (try again in a second) */
export type PairFail = 'code' | 'expired' | 'tooMany' | 'busy'
export type PairedPhone = { key: Uint8Array; name: string; id: string }

/** Six digits, every one equally likely */
export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0')

export type PairIo = { next: () => Promise<Uint8Array>; send: (msg: object) => void }

export type PairCtx = {
  /** the code now, or null when pairing is closed or the code ran out */
  code: () => string | null
  /** a wrong guess was made a moment ago: the next one waits */
  waiting: () => boolean
  /** one guess at the code was made (the phone has a box it can check its guess against): counts against the code */
  guessed: () => void
  /** a phone said hello and then nothing usable: no guess, but the same pause as one, so stalls can't hold pairing */
  stalled: () => void
  /** a counted guess didn't pair: 'tooMany' once the code is used up (the caller makes a new one) */
  failed: () => PairFail
  desktop: { id: string; name: string; publicKey: Uint8Array }
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')

function bytes(v: unknown, length: number): Uint8Array {
  if (typeof v !== 'string' || v.length > 200) throw new Error('pairing: bad field')
  const out = Uint8Array.from(Buffer.from(v, 'base64'))
  if (out.length !== length || b64(out) !== v) throw new Error('pairing: bad field')
  return out
}

function name(v: unknown): string {
  if (typeof v !== 'string') throw new Error('pairing: bad name')
  return v.replace(/\s+/g, ' ').trim().slice(0, 100)
}

async function message(io: PairIo, type: string): Promise<Record<string, unknown>> {
  const v = parseJson(await io.next()) as Record<string, unknown>
  if (!v || typeof v !== 'object' || v.type !== type) throw new Error(`pairing: expected ${type}`)
  return v
}

/** A pairHello that is well formed, or throws */
export function readHello(v: Record<string, unknown>): { phoneSession: Uint8Array; phoneName: string } {
  if (v.type !== 'pairHello' || v.v !== 1) throw new Error('pairing: bad hello')
  return { phoneSession: bytes(v.phoneSession, 16), phoneName: name(v.phoneName) }
}

/**
 * Runs the exchange after a pairHello. Resolves with the phone on success (the caller stores it and answers pairOk),
 * or the reason it was refused (already sent as pairFail). Throws when the phone breaks off or sends garbage after
 * its guess; that guess still counts (ctx.failed is called).
 */
export async function pair(io: PairIo, hello: Record<string, unknown>, ctx: PairCtx): Promise<{ phone: PairedPhone } | { fail: PairFail }> {
  const { phoneSession } = readHello(hello)
  const code = ctx.code()
  if (!code) { io.send({ type: 'pairFail', reason: 'expired' }); return { fail: 'expired' } }
  const desktopSession = sodium().randombytes_buf(16)
  const sid = new Uint8Array([...desktopSession, ...phoneSession])
  const ci = new Uint8Array([...enc.encode('yogurt-pair-v1'), ...desktopSession, ...phoneSession])
  const { ya, secret } = cpaceStart(code, ci, sid)
  // the computer's name goes only in the sealed pairConfirm box, never in the clear
  io.send({ type: 'pairStart', v: 1, desktopSession: b64(desktopSession), desktopId: ctx.desktop.id, ya: b64(ya) })
  let yb: Uint8Array
  try { yb = bytes((await message(io, 'pairReply')).yb, 32) } catch (err) { secret.scalar.fill(0); ctx.stalled(); throw err }
  // from here the phone can test its one guess against pairConfirm, so it counts whatever happens next
  ctx.guessed()
  let keys: ReturnType<typeof pairKeys> | undefined
  let paired = false
  try {
    const isk = cpaceFinish(secret, yb)
    keys = pairKeys(isk)
    isk.fill(0)
    const mine = enc.encode(JSON.stringify({ key: b64(ctx.desktop.publicKey), name: ctx.desktop.name, id: ctx.desktop.id }))
    io.send({ type: 'pairConfirm', box: b64(sealBox(keys.toPhone, mine, enc.encode('pairConfirm'))) })
    const done = await message(io, 'pairDone')
    let phone: PairedPhone
    try {
      const box = done.box
      if (typeof box !== 'string' || box.length > 2000) throw new Error('pairing: bad box')
      const v = JSON.parse(dec.decode(openBox(keys.toDesktop, Uint8Array.from(Buffer.from(box, 'base64')), enc.encode('pairDone'))))
      phone = { key: bytes(v.key, 32), name: name(v.name), id: typeof v.id === 'string' && /^[\w-]{1,64}$/.test(v.id) ? v.id : '' }
    } catch {
      // a wrong code: this side's box doesn't open
      const reason = ctx.failed()
      io.send({ type: 'pairFail', reason })
      return { fail: reason }
    }
    paired = true
    // the window closed (or the code changed) while this ran: the person no longer expects a phone
    if (ctx.code() !== code) { io.send({ type: 'pairFail', reason: 'expired' }); return { fail: 'expired' } }
    return { phone }
  } catch (err) {
    if (!paired) ctx.failed()
    throw err
  } finally {
    if (keys) for (const k of Object.values(keys)) k.fill(0)
  }
}
