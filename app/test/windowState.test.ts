import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadWindowState, placeWindow, saveWindowState } from '../src/main/windowState'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const file = () => { const d = mkdtempSync(join(tmpdir(), 'yogurt-window-')); dirs.push(d); return join(d, 'window.json') }

const screen = { x: 0, y: 25, width: 1512, height: 920 }
const defaults = { width: 1100, height: 760, minWidth: 720, minHeight: 520 }

describe('the main window opens where it was left', () => {
  it('no saved size: the default size, centred by the system', () => {
    expect(placeWindow(null, [screen], defaults)).toEqual({ width: 1100, height: 760 })
  })
  it('a saved size and place on a screen: both come back, and maximized too', () => {
    const saved = { x: 100, y: 80, width: 1300, height: 820, maximized: true }
    expect(placeWindow(saved, [screen], defaults)).toEqual({ x: 100, y: 80, width: 1300, height: 820, maximized: true })
  })
  it('a place no screen shows any more (a monitor unplugged): the saved size, centred', () => {
    expect(placeWindow({ x: 3000, y: 100, width: 1300, height: 820 }, [screen], defaults)).toEqual({ width: 1300, height: 820 })
  })
  it('never smaller than the minimum or bigger than the screen', () => {
    expect(placeWindow({ x: 10, y: 30, width: 300, height: 200 }, [screen], defaults)).toMatchObject({ width: 720, height: 520 })
    expect(placeWindow({ x: 0, y: 25, width: 4000, height: 3000 }, [screen], defaults)).toMatchObject({ width: 1512, height: 920 })
  })
  it('saves and reads back; a broken or missing file reads as nothing', () => {
    const f = file()
    expect(loadWindowState(f)).toBeNull()
    saveWindowState(f, { x: 1, y: 30, width: 900, height: 600, maximized: false })
    expect(loadWindowState(f)).toEqual({ x: 1, y: 30, width: 900, height: 600, maximized: false })
    expect(JSON.parse(readFileSync(f, 'utf8')).width).toBe(900)
    writeFileSync(f, '{not json')
    expect(loadWindowState(f)).toBeNull()
    writeFileSync(f, JSON.stringify({ width: 'wide' }))
    expect(loadWindowState(f)).toBeNull()
  })
})
