// The TCP side of the companion: each connection is either a pairing attempt (its first frame is a JSON pairHello,
// accepted only while pairing is open) or a Noise KK session from the paired phone (its first frame is Noise
// message 1; the phone is the initiator, prologue "yogurt-v1"). Anything else, an unknown key, a frame that doesn't
// decrypt or a handshake that stalls closes the socket before any request is handled.
import { createServer, type Server, type Socket } from 'node:net'
import { frame, FrameReader, parseJson } from './frames'
import { NoiseKK, type KeyPair } from './noise'
import { pair, type PairCtx, type PairedPhone } from './pairing'
import { SecureChannel, type Rekey } from './session'

export type Limits = {
  /** pairing or the Noise handshake must be done by then */
  handshakeMs: number
  /** a new connection says something by then */
  firstFrameMs: number
  /** each answer during pairing comes by then */
  stepMs: number
  /** connections not yet paired or authenticated, from one address */
  perAddress: number
  /** a session with nothing from the phone for this long is closed (it pings) */
  idleMs: number
  /** connections not yet paired or authenticated, in all; an authenticated session never counts here */
  connections: number
  /** requests waiting their turn on one session */
  queued: number
  /** first handshake messages remembered since start-up, so an exact replay is dropped at once */
  replays: number
  rekey: Rekey
}
export const LIMITS: Limits = { handshakeMs: 10_000, firstFrameMs: 3000, stepMs: 3000, perAddress: 2, idleMs: 2 * 60 * 1000, connections: 4, queued: 64, replays: 10_000, rekey: { bytes: 2 ** 30, ms: 60 * 60 * 1000 } }

const PROLOGUE = new TextEncoder().encode('yogurt-v1')
/** requests that may take long run beside the queue, so pings and pulls still get through */
const BESIDE = new Set(['ask', 'audio'])
const MAX_BESIDE = 4

export type Session = { send: (msg: object) => Promise<void>; close: () => void }

export type ServerHooks = {
  limits: Limits
  now: () => number
  /** pairing is on: a pairHello gets an answer */
  pairing: () => PairCtx | null
  paired: (phone: PairedPhone) => void
  phoneKey: () => Uint8Array | null
  /** false when this ephemeral key was seen before (a replayed message 1); remembers it otherwise */
  fresh: (ephemeral: Uint8Array) => boolean
  staticKey: () => KeyPair
  /** a session is up: the one before it (if any) is closed by the caller */
  opened: (s: Session) => void
  closed: (s: Session) => void
  handle: (msg: Record<string, unknown>, send: (m: object) => Promise<void>) => Promise<void>
  busy: (delta: 1 | -1) => void
  log: (...parts: unknown[]) => void
}

export type Listening = { port: number; close: () => Promise<void> }

export function startServer(h: ServerHooks, port: number, host: string): Promise<Listening> {
  let pairingBusy = false
  const sockets = new Set<Socket>()
  // sockets that haven't proved anything yet, by address: a few strangers can't fill the server for the phone
  const strangers = new Map<string, number>()
  let strangersAll = 0
  const server: Server = createServer({ noDelay: true }, (socket) => connection(socket))

  function connection(socket: Socket) {
    const addr = socket.remoteAddress ?? ''
    if ((strangers.get(addr) ?? 0) >= h.limits.perAddress || strangersAll >= h.limits.connections) { socket.destroy(); return }
    strangers.set(addr, (strangers.get(addr) ?? 0) + 1); strangersAll++
    let stranger = true
    const known = () => {
      if (!stranger) return
      stranger = false; strangersAll--
      const n = (strangers.get(addr) ?? 1) - 1
      if (n) strangers.set(addr, n); else strangers.delete(addr)
    }
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket); known() })
    const reader = new FrameReader()
    const early: Uint8Array[] = []
    let waiter: { resolve: (f: Uint8Array) => void; reject: (e: Error) => void } | undefined
    let onFrame: ((f: Uint8Array) => void) | undefined
    let ended = false
    const fail = (why: string) => {
      if (ended) return
      ended = true
      h.log('COMPANION', 'closed', why)
      socket.destroy()
    }
    const handshake = setTimeout(() => fail('handshake timeout'), h.limits.handshakeMs)
    const silent = setTimeout(() => fail('silent'), h.limits.firstFrameMs)
    socket.on('close', () => {
      ended = true
      clearTimeout(handshake)
      clearTimeout(silent)
      waiter?.reject(new Error('closed'))
      waiter = undefined
    })
    socket.on('error', () => {})
    socket.on('end', () => { if (!ended) { ended = true; socket.destroy() } })
    socket.on('data', (data: Buffer) => {
      let frames: Uint8Array[]
      try { frames = reader.push(data) } catch { return fail('bad framing') }
      for (const f of frames) {
        if (ended) return
        clearTimeout(silent)
        if (onFrame) { onFrame(f); continue }
        if (waiter) { const w = waiter; waiter = undefined; w.resolve(f) }
        // before the handshake the phone waits for each answer, so more than a couple queued is not a phone
        else if (early.push(f) > 2) return fail('too many frames')
      }
    })
    const next = () => early.length ? Promise.resolve(early.shift()!)
      : ended ? Promise.reject(new Error('closed')) : new Promise<Uint8Array>((resolve, reject) => { waiter = { resolve, reject } })
    /** the next frame of a pairing exchange, which comes quickly or not at all */
    const step = () => new Promise<Uint8Array>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('slow')), h.limits.stepMs)
      next().then((f) => { clearTimeout(t); resolve(f) }, (e) => { clearTimeout(t); reject(e) })
    })
    const sendJson = (msg: object) => { if (!ended) socket.write(frame(new TextEncoder().encode(JSON.stringify(msg)))) }

    void (async () => {
      const first = await next()
      const hello = first[0] === 0x7b ? jsonOf(first) : null
      if (hello?.type === 'pairHello') return pairing(hello)
      return session(first)
    })().catch((err: Error) => fail(err.message === 'closed' ? 'gone' : 'refused'))

    async function pairing(hello: Record<string, unknown>) {
      const ctx = h.pairing()
      if (!ctx) { sendJson({ type: 'pairFail', reason: 'expired' }); socket.end(); return }
      // one exchange at a time, and a pause after a wrong guess
      if (pairingBusy || ctx.waiting()) { sendJson({ type: 'pairFail', reason: 'busy' }); socket.end(); return }
      pairingBusy = true
      try {
        const r = await pair({ next: step, send: sendJson }, hello, ctx)
        if ('phone' in r) {
          h.paired(r.phone)
          sendJson({ type: 'pairOk' })
        } else h.log('COMPANION', 'pair refused', r.fail)
      } finally {
        pairingBusy = false
        clearTimeout(handshake)
      }
      socket.end()
    }

    function session(first: Uint8Array) {
      const rs = h.phoneKey()
      if (!rs) return fail('not paired')
      const noise = new NoiseKK({ initiator: false, s: h.staticKey(), rs, prologue: PROLOGUE })
      // throws when the phone isn't the paired one: closed, no request seen
      noise.readMessage(first)
      // checked after it verifies, so made-up messages can't push real ones out of the cache
      if (!h.fresh(first.subarray(0, 32))) return fail('replayed')
      socket.write(frame(noise.writeMessage(new Uint8Array(0))))
      const { send, recv } = noise.split()
      const channel = new SecureChannel(socket, send, recv, h.now, h.limits.rekey)
      if (early.length) { channel.close(); return fail('spoke before the handshake ended') }

      // msg 1 can be replayed: one that isn't followed by a frame that decrypts frees its slot after one step
      const proof = setTimeout(() => fail('no proof'), h.limits.stepMs)
      let idle: NodeJS.Timeout | undefined
      const awake = () => { clearTimeout(idle); idle = setTimeout(() => fail('idle'), h.limits.idleMs) }
      awake()
      let queue: Promise<void> = Promise.resolve(), queued = 0, beside = 0
      const s: Session = { send: (m) => channel.send(m), close: () => fail('replaced') }
      // a replayed message 1 gets this far too; only a phone holding its ephemeral key can send a frame that
      // decrypts, so that is when it counts as connected (and replaces an older session)
      let proved = false
      socket.on('close', () => { clearTimeout(idle); clearTimeout(proof); channel.close(); if (proved) h.closed(s) })
      const run = (msg: Record<string, unknown>) => {
        h.busy(1)
        return h.handle(msg, (m) => channel.send(m)).catch(() => fail('reply failed')).finally(() => h.busy(-1))
      }
      onFrame = (f) => {
        awake()
        let msg: Record<string, unknown> | null
        try { msg = channel.receive(f) } catch { return fail('bad message') }
        if (!proved) { proved = true; clearTimeout(handshake); clearTimeout(proof); known(); h.opened(s) }
        if (!msg) return
        if (msg.type === 'ping') { channel.send({ ...(typeof msg.id === 'string' ? { id: msg.id } : {}), type: 'pong', body: {} }).catch(() => fail('reply failed')); return }
        if (typeof msg.type !== 'string' || typeof msg.id !== 'string') return fail('bad request')
        if (BESIDE.has(msg.type)) {
          if (++beside > MAX_BESIDE) return fail('too many requests')
          void run(msg).finally(() => { beside-- })
          return
        }
        if (++queued > h.limits.queued) return fail('too many requests')
        queue = queue.then(() => run(msg)).finally(() => { queued-- })
      }
    }
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      server.on('error', (err) => h.log('COMPANION', 'server error', (err as NodeJS.ErrnoException).code ?? err.name))
      resolve({
        port: (server.address() as { port: number }).port,
        close: () => new Promise<void>((r) => { server.close(() => r()); for (const s of sockets) s.destroy() }),
      })
    })
  })
}

function jsonOf(f: Uint8Array): Record<string, unknown> | null {
  try {
    const v = parseJson(f)
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch { return null }
}
