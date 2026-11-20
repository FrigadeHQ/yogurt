import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
const written: Array<Record<string, string>> = []
const shareMenus: unknown[] = []
const popup = vi.fn()
const state = { clipboardFails: false, dialog: { canceled: false, filePath: '/tmp/x.md' } as { canceled: boolean; filePath?: string } }
vi.mock('electron', () => ({
  app: { getPath: () => '/docs' },
  ipcMain: { handle: (c: string, f: (...a: unknown[]) => unknown) => { handlers.set(c, f) } },
  ShareMenu: class { constructor(item: unknown) { shareMenus.push(item) } popup = popup },
  ClipboardItem: class { constructor(public items: Record<string, string>) {} },
  clipboard: { write: async (items: Array<{ items: Record<string, string> }>) => { if (state.clipboardFails) throw new Error('no'); written.push(items[0].items) } },
  dialog: { showSaveDialog: async () => state.dialog },
}))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) }
})

import { hookShare } from '../src/main/share'

const meeting = { id: 'm', title: 'Sync', startedAt: 0, endedAt: null, eventId: null, app: null, attendees: [], state: 'done', language: null }
const store = {
  meeting: (id: string) => (id === 'm' ? meeting : undefined),
  notes: () => ({ mine: 'my line', enhanced: null as string | null, edited: false }),
  segments: () => [],
  speakers: () => [],
}
const call = (c: string, ...a: unknown[]) => handlers.get(c)!({}, ...a) as Promise<string>
let dir: string

beforeEach(() => {
  vi.resetAllMocks()
  dir = mkdtempSync(join(tmpdir(), 'yogurt-share-test-'))
  handlers.clear(); written.length = 0; state.clipboardFails = false; state.dialog = { canceled: false, filePath: join(dir, 'notes.md') }
  store.notes = () => ({ mine: 'my line', enhanced: null, edited: false })
  hookShare({ store: store as never, window: () => undefined })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('share:app-link', () => {
  const sender = { mainFrame: {}, getZoomFactor: () => 1.5 }
  const event = { sender, senderFrame: sender.mainFrame }
  const window = { webContents: sender, isDestroyed: () => false, getContentSize: () => [600, 400] }
  beforeEach(() => {
    shareMenus.length = 0
    hookShare({ store: store as never, window: () => window as never })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('hands only the public site to the Mac menu and anchors it to the invoking window', () => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }))
    const open = handlers.get('share:app-link')!
    expect(open(event, 20.5, 42, 'unrelated renderer data')).toBe(true)
    expect(shareMenus).toEqual([{ urls: ['https://yogurt.so'] }])
    expect(popup).toHaveBeenCalledWith({ window, x: 31, y: 63 })
    expect(open(event, -3, 501)).toBe(true)
    expect(popup).toHaveBeenLastCalledWith({ window, x: 0, y: 399 })
  })

  it('ignores other windows, subframes, and invalid positions', () => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }))
    const open = handlers.get('share:app-link')!
    expect(open({ ...event, sender: {} }, 1, 2)).toBe(false)
    expect(open({ ...event, senderFrame: {} }, 1, 2)).toBe(false)
    expect(open(event, NaN, 2)).toBe(false)
    expect(open(event, 1, Infinity)).toBe(false)
    expect(open(event, '1', 2)).toBe(false)
    expect(shareMenus).toHaveLength(0)
  })

  it.each(['win32', 'linux'])('does not construct a native menu on %s', platform => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: platform } }))
    expect(handlers.get('share:app-link')!(event, 0, 0)).toBe(false)
    expect(shareMenus).toHaveLength(0)
  })
})

describe('share:copy', () => {
  it('copies the enhanced notes when there are some, the person\'s own when there are not', async () => {
    store.notes = () => ({ mine: 'my line', enhanced: '## Plan', edited: false })
    expect(await call('share:copy', 'm', 'notes', 'enhanced')).toBe('copied')
    expect(written.at(-1)!['text/plain']).toBe('Plan')
    expect(await call('share:copy', 'm', 'notes', 'mine')).toBe('copied')
    expect(written.at(-1)!['text/plain']).toBe('my line')
    store.notes = () => ({ mine: 'my line', enhanced: null, edited: false })
    await call('share:copy', 'm', 'notes', 'enhanced')
    expect(written.at(-1)!['text/plain']).toBe('my line')
  })
  it('checks what it is given', async () => {
    expect(await call('share:copy', 5, 'notes', 'mine')).toBe('nothing')
    expect(await call('share:copy', 'm', 'other', 'mine')).toBe('nothing')
    expect(written).toHaveLength(0)
  })
  it('copies nothing for empty notes or transcript', async () => {
    store.notes = () => ({ mine: '  ', enhanced: null, edited: false })
    expect(await call('share:copy', 'm', 'notes', 'mine')).toBe('nothing')
    expect(await call('share:copy', 'm', 'transcript', 'mine')).toBe('nothing')
    expect(written).toHaveLength(0)
  })
  it('does not substitute My notes for an explicitly emptied Enhanced result', async () => {
    store.notes = () => ({ mine: 'unrelated My notes', enhanced: '', edited: true })
    expect(await call('share:copy', 'm', 'notes', 'enhanced')).toBe('nothing')
    expect(written).toHaveLength(0)
    expect(await call('share:save', 'm', 'enhanced')).toBe('saved')
    expect(readFileSync(state.dialog.filePath!, 'utf8')).not.toContain('unrelated My notes')
  })
  it('says so when the clipboard refuses', async () => {
    state.clipboardFails = true
    expect(await call('share:copy', 'm', 'notes', 'mine')).toBe('failed')
  })
})

describe('share:save', () => {
  it('replaces an existing file where the dialog says, with complete Markdown and no temporary files', async () => {
    writeFileSync(state.dialog.filePath!, 'previous notes')
    expect(await call('share:save', 'm', 'mine')).toBe('saved')
    expect(readFileSync(state.dialog.filePath!, 'utf8')).toContain('# Sync')
    expect(readdirSync(dir)).toEqual(['notes.md'])
  })
  it('preserves the previous file when a replacement is only partially written', async () => {
    const original = Buffer.from('previous notes that must survive')
    writeFileSync(state.dialog.filePath!, original)
    vi.mocked(writeFile).mockImplementationOnce(async (path) => {
      writeFileSync(path as string, 'partial replacement')
      throw new Error('ENOSPC')
    })
    expect(await call('share:save', 'm', 'mine')).toBe('failed')
    expect(readFileSync(state.dialog.filePath!)).toEqual(original)
    expect(readdirSync(dir)).toEqual(['notes.md'])
  })
  it('preserves the previous file when the complete replacement cannot be moved into place', async () => {
    writeFileSync(state.dialog.filePath!, 'previous notes')
    vi.mocked(rename).mockRejectedValueOnce(new Error('EACCES'))
    expect(await call('share:save', 'm', 'mine')).toBe('failed')
    expect(readFileSync(state.dialog.filePath!, 'utf8')).toBe('previous notes')
    expect(readdirSync(dir)).toEqual(['notes.md'])
  })
  it('still reports saved when temporary-directory cleanup fails after replacement', async () => {
    vi.mocked(rm).mockRejectedValueOnce(new Error('cleanup denied'))
    expect(await call('share:save', 'm', 'mine')).toBe('saved')
    expect(readFileSync(state.dialog.filePath!, 'utf8')).toContain('# Sync')
  })
  it('writes nothing when the dialog is cancelled or the meeting is not there', async () => {
    state.dialog = { canceled: true }
    expect(await call('share:save', 'm', 'mine')).toBe('cancelled')
    expect(await call('share:save', 'nope', 'mine')).toBe('failed')
    expect(await call('share:save', 7, 'mine')).toBe('failed')
    expect(writeFile).not.toHaveBeenCalled()
  })
})
