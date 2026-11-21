import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hookCompanion } from '../src/main/companion/ipc'
import type { CompanionStatus } from '../src/shared/companion'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
}))

const idle: CompanionStatus = { paired: null, pairing: null, pairingClosed: null, error: null, connected: false, syncing: false }

function fake(o: { start?: () => Promise<{ code: string; expiresAt: number }> } = {}) {
  let status = idle
  const listeners = new Set<(s: CompanionStatus) => void>()
  return {
    set: (s: CompanionStatus) => { status = s; for (const l of listeners) l(s) },
    c: {
      status: () => status,
      onStatus: (cb: (s: CompanionStatus) => void) => { listeners.add(cb); return () => { listeners.delete(cb) } },
      startPairing: vi.fn(o.start ?? (async () => ({ code: '123456', expiresAt: 1 }))),
      cancelPairing: vi.fn(async () => {}),
      unpair: vi.fn(async () => {}),
    },
  }
}

const call = (channel: string) => handlers.get(channel)!({})

beforeEach(() => handlers.clear())

describe('companion IPC', () => {
  it('waits for the companion, answers its status and pushes changes to the window', async () => {
    const f = fake()
    const sent: CompanionStatus[] = []
    let ready!: (c: typeof f.c) => void
    hookCompanion({ companion: new Promise((r) => { ready = r }), send: (s) => sent.push(s) })
    const pending = call('companion:status')
    ready(f.c)
    expect(await pending).toEqual(idle)
    const paired = { ...idle, paired: { name: 'Test iPhone', lastSeen: null } }
    f.set(paired)
    expect(sent.at(-1)).toEqual(paired)
  })

  it('has no status when the companion did not start (fake mode, or it failed)', async () => {
    hookCompanion({ companion: Promise.resolve(undefined), send: () => {} })
    expect(await call('companion:status')).toBeNull()
    expect(await call('companion:start-pairing')).toEqual({ ok: false, status: null })
  })

  it('starts pairing and says when it could not, with the status explaining why', async () => {
    const f = fake()
    hookCompanion({ companion: Promise.resolve(f.c), send: () => {} })
    expect(await call('companion:start-pairing')).toEqual({ ok: true, status: idle })
    f.c.startPairing.mockImplementationOnce(async () => { f.set({ ...idle, error: 'listen' }); throw new Error('listen') })
    expect(await call('companion:start-pairing')).toEqual({ ok: false, status: { ...idle, error: 'listen' } })
  })

  it('cancels and unpairs, answering the new status', async () => {
    const f = fake()
    hookCompanion({ companion: Promise.resolve(f.c), send: () => {} })
    expect(await call('companion:cancel-pairing')).toEqual(idle)
    expect(f.c.cancelPairing).toHaveBeenCalledOnce()
    expect(await call('companion:unpair')).toEqual(idle)
    expect(f.c.unpair).toHaveBeenCalledOnce()
  })
})
