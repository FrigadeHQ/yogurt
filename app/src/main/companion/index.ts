// The iPhone companion on the desktop: off until the person starts pairing or a phone is paired. Then it listens on
// every interface (a fixed port once picked, so the phone can try the last host:port) and advertises _yogurt._tcp
// with TXT v=1, id, pairing=0|1 (no computer name: that goes sealed in pairing, then in hello). One phone at a time:
// pairing another replaces it.
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
import type { CompanionStatus } from '../../shared/companion'

export type { CompanionStatus }

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
/** codes one "Pair a phone" can go through (ATTEMPTS wrong guesses each) before pairing closes */
const CODES = 3
/** the pause after a wrong guess before the next one is taken */
const RETRY_MS = 1000

export async function createCompanion(d: CompanionDeps) {
  await ready()
  const now = d.now ?? Date.now
  const limits: Limits = { ...LIMITS, ...d.limits }
  const file = join(d.userDataDir, 'companion.json')
  const advertiser = d.advertiser ?? bonjourAdvertiser(d.log)

  const device = (): Device | null => {
    const r = d.store.db.prepare('SELECT id, name, public_key, last_seen FROM companion_devices ORDER BY paired_at DESC LIMIT 1').get()
    return r ? { id: String(r.id), name: String(r.name), key: Uint8Array.from(Buffer.from(String(r.public_key), 'base64')), lastSeen: r.last_seen == null ? null : Number(r.last_seen) } : null
  }

  // this computer's id and static key, made once; the private half sealed on disk
  const found = identity()
  if ('locked' in found) return lockedCompanion(found.locked, device)
  const { saved, keys } = found
  function identity(): { saved: Saved; keys: KeyPair } | { locked: string } {
    let s: Saved | undefined
    try {
      const v = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
      if (v && typeof v.id === 'string' && typeof v.publicKey === 'string' && typeof v.privateKey === 'string') s = v
    } catch { /* not JSON: made again below */ }
    if (s) {
      let plain: string
      // the keychain said no (locked, denied, not ready): keep the file and the pairing, try again next start
      try { plain = d.open(s.privateKey) } catch (err) { d.log('COMPANION', 'keychain would not open the key', (err as Error).name); return { locked: s.id } }
      const keys = keyPairFromPrivate(Uint8Array.from(Buffer.from(plain, 'base64')))
      if (keys.privateKey.length === 32 && Buffer.from(keys.publicKey).toString('base64') === s.publicKey) return { saved: s, keys }
      d.log('COMPANION', 'identity does not match its key, making a new one')
    }
    // a new key means the phone has to pair again
    d.store.db.exec('DELETE FROM companion_devices')
    const keys = generateKeyPair()
    const made: Saved = { id: randomUUID(), publicKey: Buffer.from(keys.publicKey).toString('base64'), privateKey: d.seal(Buffer.from(keys.privateKey).toString('base64')) }
    writeFileSync(file, JSON.stringify(made, null, 2), { mode: 0o600 })
    return { saved: made, keys }
  }
  const persist = () => writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 })

  let pairing: { code: string; expiresAt: number; attemptsLeft: number; codes: number } | null = null
  let pairingClosed: CompanionStatus['pairingClosed'] = null
  let retryAt = 0
  let listenFailed = false
  /** the network refused the advert: the phone can't find this computer (cleared once one connects, or pairing starts again) */
  let advertFailed = false
  advertiser.onFailure = () => {
    if (advertFailed) return
    advertFailed = true
    emit()
  }
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
      pairing: open && { code: open.code, expiresAt: open.expiresAt, attemptsLeft: open.attemptsLeft },
      pairingClosed,
      error: listenFailed ? 'listen' : advertFailed ? 'network' : null,
      connected: !!session,
      syncing: busy > 0,
    }
  }
  const emit = () => { const s = status(); for (const cb of listeners) cb(s) }

  /** the pairing window, if still open: it closes on its own after PAIR_MS */
  function openPairing() {
    if (pairing && now() >= pairing.expiresAt) closePairing('expired')
    return pairing
  }

  function closePairing(why: CompanionStatus['pairingClosed']) {
    pairing = null
    pairingClosed = why
    clearTimeout(expiry)
    void refresh()
  }

  /** A new code. One "Pair a phone" keeps its first two minutes, however many codes it goes through. */
  function freshCode(window?: { expiresAt: number; codes: number }) {
    const expiresAt = window?.expiresAt ?? now() + PAIR_MS
    pairing = { code: newCode(), expiresAt, attemptsLeft: ATTEMPTS, codes: (window?.codes ?? 0) + 1 }
    clearTimeout(expiry)
    expiry = setTimeout(() => { openPairing(); emit() }, Math.max(0, expiresAt - now()) + 50)
    expiry.unref?.()
  }

  const pairCtx = (): PairCtx | null => openPairing() && {
    code: () => openPairing()?.code ?? null,
    waiting: () => now() < retryAt,
    guessed: () => { if (pairing) pairing.attemptsLeft-- },
    stalled: () => { retryAt = now() + RETRY_MS },
    failed: () => {
      d.log('COMPANION', 'pair attempt failed', `left=${pairing?.attemptsLeft ?? 0}`)
      retryAt = now() + RETRY_MS
      if (pairing && pairing.attemptsLeft <= 0) {
        // someone may be guessing: a few codes, then the person has to start pairing again
        if (pairing.codes >= CODES) closePairing('tooMany')
        else freshCode(pairing)
        emit()
        return 'tooMany'
      }
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
    closePairing(null)
    d.log('COMPANION', 'paired', id)
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

  // every message 1 since start-up, oldest first, kept across the server turning off and on
  const seenEphemerals = new Set<string>()
  const fresh = (e: Uint8Array) => {
    const k = Buffer.from(e).toString('base64')
    if (seenEphemerals.has(k)) return false
    seenEphemerals.add(k)
    if (seenEphemerals.size > limits.replays) seenEphemerals.delete(seenEphemerals.values().next().value!)
    return true
  }

  async function listen() {
    if (server || stopped) return
    starting ??= (async () => {
      const hooks = {
        limits, now, log: d.log,
        pairing: pairCtx, paired,
        phoneKey: () => device()?.key ?? null,
        fresh,
        staticKey: () => keys,
        opened: (s: Session) => {
          session?.close()
          session = s
          advertFailed = false
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
        try {
          server = await startServer(hooks, saved.port ?? 0, host)
        } catch (err) {
          // the port we had is taken now: a new one (the phone finds it again through Bonjour)
          if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
          server = await startServer(hooks, 0, host)
        }
      } catch (err) { listenFailed = true; throw err }
      listenFailed = false
      const port = server.port
      if (port !== saved.port) { saved.port = port; persist() }
      d.log('COMPANION', 'listening', `port=${port}`)
    })().finally(() => { starting = null })
    await starting
  }

  /** On while pairing or paired, off otherwise; the advertisement follows. One at a time, so the last word wins. */
  let refreshing: Promise<void> = Promise.resolve()
  const refresh = () => {
    refreshing = refreshing.then(turn).catch((err) => {
      d.log('COMPANION', 'could not turn on or off', (err as NodeJS.ErrnoException).code ?? (err as Error).name)
    })
    return refreshing
  }
  const wanted = () => !stopped && (!!pairing || !!device())
  async function turn() {
    if (wanted()) await listen()
    // asked again while it started (pairing cancelled, expired): off after all
    if (!wanted() || !server) {
      advertiser.stop()
      if (!stopped) session?.close()
      const s = server
      server = null
      await s?.close()
      return
    }
    // no computer name in the open: anyone on the Wi-Fi sees the advert. The phone gets it sealed when pairing, then in hello
    advertiser.publish({ name: `Yogurt ${saved.id.slice(0, 8)}`, port: saved.port!, txt: { v: '1', id: saved.id, pairing: pairing ? '1' : '0' } })
  }

  await refresh()

  return {
    /** a new six-digit code for two minutes; the server starts if it wasn't running */
    async startPairing(): Promise<{ code: string; expiresAt: number }> {
      listenFailed = false
      advertFailed = false
      freshCode()
      pairingClosed = null
      retryAt = 0
      const { code, expiresAt } = pairing!
      emit()
      await refresh()
      // nothing listens, so no phone could reach the code: closed, and the status says why (also when it was
      // cancelled meanwhile, so the caller never hears ok for a code nobody could use)
      if (!server && listenFailed) {
        if (pairing?.code === code) { pairing = null; clearTimeout(expiry); await refresh() }
        emit()
        throw new Error('listen')
      }
      d.log('COMPANION', 'pairing opened')
      return { code, expiresAt }
    },
    async cancelPairing() {
      listenFailed = false
      closePairing(null)
      await refresh()
      emit()
    },
    async unpair() {
      listenFailed = false
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
      session?.close()
      // goodbye first, so the phone sees this computer leave rather than waiting out the record's lifetime
      await advertiser.destroy?.()
      await refresh()
      await handlers.reset()
      sodium().memzero(keys.privateKey)
    },
  }
}


/** The keychain wouldn't open the key: everything stays as it was, off, and says why. */
function lockedCompanion(desktopId: string, device: () => { name: string; lastSeen: number | null } | null) {
  const status = (): CompanionStatus => {
    const dev = device()
    return { paired: dev && { name: dev.name, lastSeen: dev.lastSeen }, pairing: null, pairingClosed: null, error: 'keychain', connected: false, syncing: false }
  }
  return {
    async startPairing(): Promise<{ code: string; expiresAt: number }> { throw new Error('keychain') },
    async cancelPairing() {},
    async unpair() {},
    status,
    onStatus(_cb: (s: CompanionStatus) => void) { return () => {} },
    port: (): number | null => null,
    desktopId,
    publicKey: new Uint8Array(0),
    async stop() {},
  }
}

export type Companion = Awaited<ReturnType<typeof createCompanion>>
