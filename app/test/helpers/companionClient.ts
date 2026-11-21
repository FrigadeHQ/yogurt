// A stand-in iPhone for the companion server tests: real localhost sockets, the phone's side of pairing and Noise KK.
import { connect, type Socket } from 'node:net'
import { cpaceRespond, pairKeys } from '../../src/main/companion/cpace'
import { openBox, sealBox } from '../../src/main/companion/box'
import { frame, FrameReader } from '../../src/main/companion/frames'
import { NoiseKK, type KeyPair } from '../../src/main/companion/noise'
import { SecureChannel, type Rekey } from '../../src/main/companion/session'

const enc = new TextEncoder()
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
const unb64 = (s: unknown) => Uint8Array.from(Buffer.from(String(s), 'base64'))

export type Raw = {
  socket: Socket
  next: (timeoutMs?: number) => Promise<Uint8Array>
  send: (payload: Uint8Array) => void
  sendJson: (o: object) => void
  json: () => Promise<Record<string, unknown>>
  /** resolves once the server has closed the connection */
  closed: Promise<void>
  onFrame?: (f: Uint8Array) => void
}

export async function raw(port: number): Promise<Raw> {
  const socket = connect(port, '127.0.0.1')
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  const reader = new FrameReader()
  const queue: Uint8Array[] = []
  const waiting: { resolve: (f: Uint8Array) => void; reject: (e: Error) => void }[] = []
  let gone = false
  const r: Raw = {
    socket,
    closed: new Promise((resolve) => socket.on('close', () => resolve())),
    next: (timeoutMs = 3000) => queue.length ? Promise.resolve(queue.shift()!) : gone ? Promise.reject(new Error('closed')) : new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), timeoutMs)
      waiting.push({ resolve: (f) => { clearTimeout(t); resolve(f) }, reject: (e) => { clearTimeout(t); reject(e) } })
    }),
    send: (p) => socket.write(frame(p)),
    sendJson: (o) => socket.write(frame(enc.encode(JSON.stringify(o)))),
    json: async () => JSON.parse(new TextDecoder().decode(await r.next())),
  }
  socket.on('data', (d: Buffer) => {
    for (const f of reader.push(d)) {
      if (r.onFrame) r.onFrame(f)
      else if (waiting.length) waiting.shift()!.resolve(f)
      else queue.push(f)
    }
  })
  socket.on('error', () => {})
  socket.on('close', () => { gone = true; while (waiting.length) waiting.shift()!.reject(new Error('closed')) })
  return r
}

export type PairResult = { result: Record<string, unknown>; desktop?: { key: Uint8Array; name: string; id: string } }

/** The phone's side of pairing with this code; a wrong code still sends pairDone (sealed under its own key). */
export async function pairAsPhone(port: number, code: string, phone: KeyPair, name = 'Test iPhone'): Promise<PairResult> {
  const c = await raw(port)
  try {
    const phoneSession = crypto.getRandomValues(new Uint8Array(16))
    c.sendJson({ type: 'pairHello', v: 1, phoneSession: b64(phoneSession), phoneName: name })
    const start = await c.json()
    if (start.type !== 'pairStart') return { result: start }
    const desktopSession = unb64(start.desktopSession)
    const sid = new Uint8Array([...desktopSession, ...phoneSession])
    const ci = new Uint8Array([...enc.encode('yogurt-pair-v1'), ...desktopSession, ...phoneSession])
    const { yb, isk } = cpaceRespond(code, ci, sid, unb64(start.ya))
    c.sendJson({ type: 'pairReply', yb: b64(yb) })
    const keys = pairKeys(isk)
    const confirm = await c.json()
    let desktop: PairResult['desktop']
    try {
      const v = JSON.parse(new TextDecoder().decode(openBox(keys.toPhone, unb64(confirm.box), enc.encode('pairConfirm'))))
      desktop = { key: unb64(v.key), name: v.name, id: v.id }
    } catch { /* wrong code */ }
    const mine = enc.encode(JSON.stringify({ key: b64(phone.publicKey), name, id: 'phone-' + b64(phone.publicKey).slice(0, 8).replace(/[^\w]/g, 'x') }))
    c.sendJson({ type: 'pairDone', box: b64(sealBox(keys.toDesktop, mine, enc.encode('pairDone'))) })
    return { result: await c.json(), desktop }
  } finally {
    c.socket.destroy()
  }
}

export type Phone = {
  raw: Raw
  request: (type: string, body?: object) => Promise<Record<string, unknown>>
  /** messages that weren't replies to a request: changed pushes, audioChunks */
  pushes: Record<string, unknown>[]
  waitPush: (pred: (m: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>
  send: (m: object) => Promise<void>
  close: () => void
}

/** A Noise KK session as the phone (initiator). */
export async function session(port: number, phone: KeyPair, desktopKey: Uint8Array, rekey?: Rekey): Promise<Phone> {
  const c = await raw(port)
  const noise = new NoiseKK({ initiator: true, s: phone, rs: desktopKey, prologue: enc.encode('yogurt-v1') })
  c.send(noise.writeMessage(new Uint8Array(0)))
  noise.readMessage(await c.next())
  const { send, recv } = noise.split()
  const channel = new SecureChannel(c.socket, send, recv, Date.now, rekey)
  const waiting = new Map<string, (m: Record<string, unknown>) => void>()
  const pushes: Record<string, unknown>[] = []
  const watchers: { pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }[] = []
  c.onFrame = (f) => {
    const m = channel.receive(f)
    if (!m) return
    const w = typeof m.id === 'string' && (m.type === 'ok' || m.type === 'error') ? waiting.get(m.id) : undefined
    if (w) { waiting.delete(m.id as string); w(m); return }
    pushes.push(m)
    for (const x of [...watchers]) if (x.pred(m)) { watchers.splice(watchers.indexOf(x), 1); x.resolve(m) }
  }
  let n = 0
  return {
    raw: c, pushes,
    send: (m) => channel.send(m),
    request: (type, body = {}) => new Promise((resolve, reject) => {
      const id = `r${++n}`
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 5000)
      waiting.set(id, (m) => { clearTimeout(t); resolve(m) })
      void c.closed.then(() => { clearTimeout(t); reject(new Error('closed')) })
      channel.send({ id, type, body }).catch(reject)
    }),
    waitPush: (pred, timeoutMs = 3000) => {
      const found = pushes.find(pred)
      if (found) return Promise.resolve(found)
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no push')), timeoutMs)
        watchers.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m) } })
      })
    },
    close: () => c.socket.destroy(),
  }
}
