import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const quit = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ app: { quit } }))
import { app } from 'electron'
import { activeMeeting, initMeetings, pauseMeetingClock, startMeeting, stopMeeting } from '../src/main/meeting'
import { openStore } from '../src/main/store'
import { CLOSED, QUIT_MARKER, quitByUser, quitCalledOff, quitting, resetQuitByUser, started, recordingQuitGuard } from '../src/main/quitByUser'

let dir: string
const marked = () => existsSync(join(dir, QUIT_MARKER))
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'yq-')); quit.mockClear(); resetQuitByUser() })

describe('the person quitting Yogurt keeps AI apps from starting it again (#147)', () => {
  it('is marked when the person chose Quit', () => {
    quitByUser()
    expect(quit).toHaveBeenCalledOnce()
    quitting(dir)
    expect(marked()).toBe(true)
  })
  it('is not marked for any other quit: an update restart, logout, a quiet Yogurt quitting by itself', () => {
    quitting(dir)
    expect(marked()).toBe(false)
  })
  it('is not marked when the quit was called off (unsaved notes: Return to notes)', () => {
    quitByUser()
    quitCalledOff()
    quitting(dir)
    expect(marked()).toBe(false)
  })
  it('is cleared by any start but an AI app’s', () => {
    for (const reason of ['user', 'login', 'update'] as const) {
      quitByUser(); quitting(dir); resetQuitByUser()
      expect(started(dir, reason)).toBe(false)
      expect(marked()).toBe(false)
    }
  })
  it('is kept by an AI app’s start, which then stops at once', () => {
    quitByUser(); quitting(dir)
    expect(started(dir, 'ai-app')).toBe(true)
    expect(marked()).toBe(true)
    rmSync(join(dir, QUIT_MARKER))
    expect(started(dir, 'ai-app')).toBe(false)
  })
  it('is what both yogurt-mcp helpers look for, with the same words', () => {
    for (const f of ['native/yogurt-mcp-relay/src/main.rs', 'native/yogurt-mcp/main.swift']) {
      const src = readFileSync(join(__dirname, '..', f), 'utf8')
      expect(src).toContain(`"${QUIT_MARKER}"`)
      expect(src).toContain(`"${CLOSED}"`)
    }
  })
})

describe('quitting during a recording', () => {
  beforeEach(() => { app.quit = quit; quit.mockReset() })

  it.each(['darwin', 'win32', 'linux'] as const)('asks by recording state and quit source on %s', async os => {
    const store = openStore(':memory:')
    initMeetings(store)
    const confirm = vi.fn(async (_signal: AbortSignal) => false)
    const wait = recordingQuitGuard(() => activeMeeting()?.id, confirm, os)
    const check = async (recording: boolean) => {
      expect(wait(true)).toBe(false) // OS shutdown, restart or logout.
      expect(wait(false)).toBe(recording && os === 'darwin') // Native quit, including the Dock on Mac.
      await nextTurn()
      confirm.mockClear()
      quit.mockImplementationOnce(() => expect(wait(false)).toBe(recording))
      quitByUser() // Menu, shortcut or tray.
      expect(confirm).toHaveBeenCalledTimes(recording ? 1 : 0)
      quit.mockImplementationOnce(() => expect(wait(false)).toBe(false))
      app.quit() // Update install or an internal quit, even while the confirmation is open.
      if (recording) expect(confirm.mock.lastCall![0].aborted).toBe(true)
      quitCalledOff()
    }
    try {
      await check(false)
      const meeting = startMeeting({ title: 'Review', event: null, app: null })
      await check(true)
      pauseMeetingClock(meeting.id, true)
      await check(true)
      stopMeeting(meeting.id)
      await check(false)
    } finally { store.close() }
  })

  it('asks once, keeps recording on Cancel and continues shutdown once on confirmation', async () => {
    let choose!: (stop: boolean) => void
    const confirm = vi.fn(() => new Promise<boolean>(resolve => { choose = resolve }))
    const wait = recordingQuitGuard(() => 'meeting', confirm, 'darwin')
    const finish = vi.fn()
    quit.mockImplementation(() => { if (!wait(false)) finish() })
    quitByUser()
    quitByUser()
    expect(confirm).toHaveBeenCalledOnce()
    choose(false)
    await nextTurn()
    quitting(dir)
    expect(marked()).toBe(false)
    expect(finish).not.toHaveBeenCalled()
    quitByUser()
    expect(confirm).toHaveBeenCalledTimes(2)
    choose(true)
    await nextTurn()
    expect(finish).toHaveBeenCalledOnce()
    expect(confirm).toHaveBeenCalledTimes(2)
  })
})
