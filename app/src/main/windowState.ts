import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The main window opens the size and place it was left at, so it never has to be resized on every start. A place no
 * screen shows any more (a monitor unplugged) keeps the size and lets the system centre it.
 */
export type WindowState = { x: number; y: number; width: number; height: number; maximized?: boolean }
type Area = { x: number; y: number; width: number; height: number }
type Defaults = { width: number; height: number; minWidth: number; minHeight: number }
export type Placement = { x?: number; y?: number; width: number; height: number; maximized?: boolean }

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function loadWindowState(file: string): WindowState | null {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'))
    if (!s || ![s.x, s.y, s.width, s.height].every(num)) return null
    return { x: s.x, y: s.y, width: s.width, height: s.height, maximized: s.maximized === true }
  } catch { return null }
}

export function saveWindowState(file: string, s: WindowState) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    // written whole and swapped in, so a crash mid-write never leaves half a file
    writeFileSync(`${file}.tmp`, JSON.stringify(s))
    renameSync(`${file}.tmp`, file)
  } catch (e) { console.warn('could not save the window size', e) }
}

/** where the window opens: the saved place if a screen still shows enough of it, the saved size within the limits */
export function placeWindow(saved: WindowState | null, screens: Area[], d: Defaults): Placement {
  if (!saved) return { width: d.width, height: d.height }
  const biggest = screens.reduce((a, s) => (s.width * s.height > a.width * a.height ? s : a), screens[0] ?? { x: 0, y: 0, width: d.width, height: d.height })
  const width = Math.min(Math.max(saved.width, d.minWidth), biggest.width)
  const height = Math.min(Math.max(saved.height, d.minHeight), biggest.height)
  // a screen must show the window's top strip (where it is dragged from), at least 100 points of it
  const seen = screens.some((s) => {
    const left = Math.max(s.x, saved.x), right = Math.min(s.x + s.width, saved.x + width)
    return right - left >= 100 && saved.y >= s.y && saved.y < s.y + s.height - 40
  })
  const maximized = saved.maximized ? { maximized: true } : {}
  return seen ? { x: saved.x, y: saved.y, width, height, ...maximized } : { width, height, ...maximized }
}
