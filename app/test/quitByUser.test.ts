import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const quit = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ app: { quit } }))
import { CLOSED, QUIT_MARKER, quitByUser, quitCalledOff, quitting, resetQuitByUser, started } from '../src/main/quitByUser'

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
