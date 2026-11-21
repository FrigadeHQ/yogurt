// The iPhone companion on the desktop: off until the person starts pairing or a phone is paired. Then it listens on
// every interface (a fixed port once picked, so the phone can try the last host:port) and advertises _yogurt._tcp
// with TXT v=1, id, name, pairing=0|1. One phone at a time: pairing another replaces it.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from '../store'
import { ready, sodium } from './sodium'
import { keyPairFromPrivate, generateKeyPair, type KeyPair } from './noise'
import { ATTEMPTS, newCode, PAIR_MS, type PairCtx, type PairedPhone } from './pairing'
import { createHandlers, type HandlerDeps } from './handlers'
import { LIMITS, startServer, type Limits, type Listening, type Session } from './server'
import { bonjourAdvertiser, type Advertiser } from './advertise'

export type CompanionStatus = {
  paired: null | { name: string; lastSeen: number | null }
  pairing: null | { code: string; expiresAt: number; attemptsLeft: number }
  connected: boolean
  syncing: boolean
}

export type CompanionDeps = Omit<HandlerDeps, 'now' | 'store'> & {
  store: Store
  userDataDir: string
  /** keep the private key sealed with the system keychain (safeStorage) */
  seal: (plain: string) => string
  open: (sealed: string) => string
  deviceName: () => string
  appVersion?: string
  /** a meeting is recording: its transcript changes all the time, so the phone hears of changes less often */
  recording?: () => boolean
  // for tests
  now?: () => number
  host?: string
  advertiser?: Advertiser
  limits?: Partial<Limits>
  /** how often the change log is checked for something new to tell the phone about */
  pollMs?: number
}

type Saved = { id: string; port?: number; publicKey: string; privateKey: string }
type Device = { id: string; name: string; key: Uint8Array; lastSeen: number | null }

/** While recording, a `changed` goes out at most this often */
const RECORDING_PUSH_MS = 30_000

export async function createCompanion(d: CompanionDeps) {
  await ready()
  const now = d.now ?? Date.now
  const limits: Limits = { ...LIMITS, ...d.limits }
  const file = join(d.userDataDir, 'companion.json')
  const advertiser = d.advertiser ?? bonjourAdvertiser(d.log)

  // this computer's id and static key, made once; the private half sealed on disk
  const { saved, keys } = identity()
  function identity(): { saved: Saved; keys: KeyPair } {
    try {
      if (existsSync(file)) {
        const s = JSON.parse(readFileSync(file, 'utf8')) as Saved
        const keys = keyPairFromPrivate(Uint8Array.from(Buffer.from(d.open(s.privateKey), 'base64')))
        if (keys.privateKey.length === 32 && Buffer.from(keys.publicKey).toString('base64') === s.publicKey) return { saved: s, keys }
      }
    } catch (err) { d.log('COMPANION', 'identity unreadable, making a new one', (err as Error).name) }
    // a new key means the phone has to pair again
    d.store.db.exec('DELETE FROM companion_devices')
    const keys = generateKeyPair()
    const s: Saved = { id: randomUUID(), publicKey: Buffer.from(keys.publicKey).toString('base64'), privateKey: d.seal(Buffer.from(keys.privateKey).toString('base64')) }
    writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 })
    return { saved: s, keys }
  }
  const persist = () => writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 })

  const device = (): Device | null => {
    const r = d.store.db.prepare('SELECT id, name, public_key, last_seen FROM companion_devices ORDER BY paired_at DESC LIMIT 1').get()
    return r ? { id: String(r.id), name: String(r.name), key: Uint8Array.from(Buffer.from(String(r.public_key), 'base64')), lastSeen: r.last_seen == null ? null : Number(r.last_seen) } : null
  }

  let pairing: { code: string; expiresAt: number; attemptsLeft: number } | null = null
  let expiry: NodeJS.Timeout | undefined
  let server: Listening | null = null
  let starting: Promise<void> | null = null
  let session: Session | null = null
  let busy = 0
  let stopped = false
  const listeners = new Set<(s: CompanionStatus) => void>()

  const status = (): CompanionStatus => {
    const dev = device()
    const open = openPairing()
    return {
      paired: dev && { name: dev.name, lastSeen: dev.lastSeen },
      pairing: open && { ...open },
      connected: !!session,
      syncing: busy > 0,
    }
  }
  const emit = () => { const s = status(); for (const cb of listeners) cb(s) }

  /** the pairing window, if still open: it closes on its own after PAIR_MS */
  function openPairing() {
    if (pairing && now() >= pairing.expiresAt) { pairing = null; clearTimeout(expiry); void refresh() }
    return pairing
  }

  function freshCode() {
    pairing = { code: newCode(), expiresAt: now() + PAIR_MS, attemptsLeft: ATTEMPTS }
    clearTimeout(expiry)
    expiry = setTimeout(() => { openPairing(); emit() }, PAIR_MS + 50)
    expiry.unref?.()
  }

  const pairCtx = (): PairCtx | null => openPairing() && {
    code: () => openPairing()?.code ?? null,
    guessed: () => { if (pairing) pairing.attemptsLeft-- },
    failed: () => {
      d.log('COMPANION', 'pair attempt failed', `left=${pairing?.attemptsLeft ?? 0}`)
      if (pairing && pairing.attemptsLeft <= 0) { freshCode(); emit(); return 'tooMany' }
      emit()
      return 'code'
    },
    desktop: { id: saved.id, name: d.deviceName(), publicKey: keys.publicKey },
  }

  function paired(phone: PairedPhone) {
    const keyB64 = Buffer.from(phone.key).toString('base64')
    const id = phone.id || createHash('sha256').update(phone.key).digest('hex').slice(0, 32)
    // one phone: a new pairing replaces the old one, and the old one's session ends
    d.store.db.exec('BEGIN')
    try {
      d.store.db.exec('DELETE FROM companion_devices')
      d.store.db.prepare('INSERT INTO companion_devices (id, name, public_key, paired_at, last_seen) VALUES (?, ?, ?, ?, NULL)').run(id, phone.name || 'iPhone', keyB64, now())
      d.store.db.exec('COMMIT')
    } catch (err) { d.store.db.exec('ROLLBACK'); throw err }
    session?.close()
    pairing = null
    clearTimeout(expiry)
    d.log('COMPANION', 'paired', id)
    void refresh()
    emit()
  }

  const seen = () => { d.store.db.prepare('UPDATE companion_devices SET last_seen = ?').run(now()) }

  const handlers = createHandlers({
    ...d, now,
    hello: () => ({ desktopId: saved.id, desktopName: d.deviceName(), desktopVersion: d.appVersion ?? '' }),
    uploadDir: join(d.userDataDir, 'companion-uploads'),
  })

  // tells the phone when the change log moved, so it pulls; checked rather than hooked, so every write path counts
  let lastCursor = 0, lastPush = 0
  const maxSeq = () => Number(d.store.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM companion_changes').get()?.seq ?? 0)
  const poll = setInterval(() => {
    if (!session) return
    const cursor = maxSeq()
    if (cursor === lastCursor) return
    if (d.recording?.() && now() - lastPush < RECORDING_PUSH_MS) return
    lastCursor = cursor; lastPush = now()
    session.send({ type: 'changed', body: { cursor } }).catch(() => {})
  }, d.pollMs ?? 1000)
  poll.unref?.()

  async function listen() {
    if (server || stopped) return
    starting ??= (async () => {
      const hooks = {
        limits, now, log: d.log,
        pairing: pairCtx, paired,
        phoneKey: () => device()?.key ?? null,
        staticKey: () => keys,
        opened: (s: Session) => {
          session?.close()
          session = s
          lastCursor = maxSeq()
          seen()
          d.log('COMPANION', 'session opened')
          emit()
        },
        closed: (s: Session) => {
          if (session !== s) return
          session = null
          busy = 0
          seen()
          void handlers.reset()
          d.log('COMPANION', 'session closed')
          emit()
        },
        handle: handlers.handle,
        busy: (delta: 1 | -1) => { const was = busy > 0; busy = Math.max(0, busy + delta); if (was !== busy > 0) emit() },
      }
      const host = d.host ?? '0.0.0.0'
      try {
        server = await startServer(hooks, saved.port ?? 0, host)
      } catch (err) {
        // the port we had is taken now: a new one (the phone finds it again through Bonjour)
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
        server = await startServer(hooks, 0, host)
      }
      const port = server.port
      if (port !== saved.port) { saved.port = port; persist() }
      d.log('COMPANION', 'listening', `port=${port}`)
    })().finally(() => { starting = null })
    await starting
  }

  /** On while pairing or paired, off otherwise; the advertisement follows */
  async function refresh() {
    if (stopped) return
    const on = !!pairing || !!device()
    if (!on) {
      advertiser.stop()
      session?.close()
      const s = server
      server = null
      await s?.close()
      return
    }
    await listen()
    if (!server) return
    advertiser.publish({ name: `Yogurt ${saved.id.slice(0, 8)}`, port: saved.port!, txt: { v: '1', id: saved.id, name: d.deviceName(), pairing: pairing ? '1' : '0' } })
  }

  await refresh()

  return {
    /** a new six-digit code for two minutes; the server starts if it wasn't running */
    async startPairing(): Promise<{ code: string; expiresAt: number }> {
      freshCode()
      await refresh()
      emit()
      d.log('COMPANION', 'pairing opened')
      return { code: pairing!.code, expiresAt: pairing!.expiresAt }
    },
    async cancelPairing() {
      pairing = null
      clearTimeout(expiry)
      await refresh()
      emit()
    },
    async unpair() {
      d.store.db.exec('DELETE FROM companion_devices')
      session?.close()
      d.log('COMPANION', 'unpaired')
      await refresh()
      emit()
    },
    status,
    onStatus(cb: (s: CompanionStatus) => void) { listeners.add(cb); return () => { listeners.delete(cb) } },
    /** the port it listens on, when it does */
    port: () => server?.port ?? null,
    desktopId: saved.id,
    publicKey: keys.publicKey,
    async stop() {
      stopped = true
      clearInterval(poll)
      clearTimeout(expiry)
      advertiser.stop()
      advertiser.destroy?.()
      session?.close()
      const s = server
      server = null
      await s?.close()
      await handlers.reset()
      sodium().memzero(keys.privateKey)
    },
  }
}

export type Companion = Awaited<ReturnType<typeof createCompanion>>
