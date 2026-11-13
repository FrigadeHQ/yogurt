import { beforeEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Folder, MeetingCard } from '../src/shared/types'
import { PastNotes } from '../src/renderer/src/screens/Home'
import { FolderChip, FolderPicker } from '../src/renderer/src/components/FolderPicker'

const state = vi.hoisted(() => ({ all: [] as Folder[], mine: [] as Folder[] }))
vi.mock('../src/renderer/src/folders', () => ({ useFolders: (id?: string) => id ? state.mine : state.all, setMeetingsInFolder: vi.fn() }))
vi.mock('../src/renderer/src/i18n', () => ({ useLanguage: () => 'en' }))
vi.mock('../src/renderer/src/motion', () => ({ useReducedMotion: () => false }))
vi.mock('../src/renderer/src/components/TrashToast', () => ({ toasts: { add: vi.fn(), close: vi.fn() } }))
const suggested: Folder = { id: 'suggested', name: 'Customer research and planning', icon: 'rocket', color: 'violet', count: 0, createdAt: 1 }
const alpha: Folder = { ...suggested, id: 'alpha', name: 'Alpha' }
beforeEach(() => { state.all = [alpha, suggested]; state.mine = [] })
const chip = (row = false) => renderToStaticMarkup(createElement(FolderChip, { meetingId: 'meeting', onNew() {}, row, rowFolders: row ? state.mine : undefined, suggestion: { folder: suggested, dismiss() {} } }))

it('renders the folder name and real glyph, then dismiss and confirm inside the suggestion chip', () => {
  const html = chip()
  expect(html).toContain(`>${suggested.name}</span>`)
  expect(html).toContain('data-folder-icon="rocket"')
  expect(html).toContain('data-folder-color="violet"')
  expect(html).not.toContain('planning?')
  expect([...html.matchAll(/<button[^>]*data-testid="([^"]+)"/g)].map(match => match[1]))
    .toEqual(['note-folders', 'folder-suggestion-cancel', 'folder-suggestion-confirm'])
  expect(html).toContain('aria-haspopup="menu"')
  expect(html).toContain('class="note-folder-actions"')
  expect(html).toContain('class="note-chip note-folder-proposal ')
  expect(html).not.toContain('meeting-folder-pill')
  expect(html.match(/width="15" height="15"/g)).toHaveLength(2)
})

it('shows the filed chip when another folder was chosen', () => {
  state.mine = [alpha]
  const html = chip()
  expect(html).not.toContain('data-testid="folder-suggestion"')
  expect(html).toContain('>Alpha</span>')
})

it('renders the row suggestion as a folder pill with three keyboard controls and smaller action icons', () => {
  const html = chip(true)
  expect(html).toContain('class="meeting-folder-pill meeting-folder-proposal"')
  expect(html).not.toContain('note-chip')
  expect(html).not.toContain('note-folder-proposal')
  expect(html).toContain('role="group" aria-label="Suggested"')
  expect(html).toContain('class="meeting-folder-dot" data-folder-color="violet"')
  expect(html).not.toContain('data-folder-icon=')
  expect([...html.matchAll(/<button[^>]*data-testid="([^"]+)"/g)].map(match => match[1]))
    .toEqual(['note-folders', 'folder-suggestion-cancel', 'folder-suggestion-confirm'])
  expect(html).toContain('aria-haspopup="menu"')
  expect(html).toContain('aria-label="Dismiss suggestion"')
  expect(html).toContain('aria-label="Add to folder"')
  expect(html).not.toMatch(/disabled|tabindex="-1"/)
  expect(html.match(/width="12" height="12"/g)).toHaveLength(2)
})

it('hides row suggestions for any existing membership', () => {
  for (const folders of [[alpha], [suggested], [alpha, suggested]]) {
    state.mine = folders
    expect(chip(true)).toBe('')
    expect(chip()).not.toContain('data-testid="folder-suggestion"')
  }
})

it('has no empty frame when the folder hook refreshes before the Meetings list', () => {
  const row = (folders: Folder[]) => renderToStaticMarkup(createElement(FolderChip, {
    meetingId: 'meeting', row: true, rowFolders: folders,
    suggestion: { folder: suggested, dismiss() {} },
    children: folders.map(folder => createElement('button', { key: folder.id, 'data-testid': 'past-note-folder' }, folder.name)),
  }))
  expect(row([])).toContain('data-testid="folder-suggestion"')
  state.mine = [suggested]
  // The hook's newer result must not hide a pill still absent from the list snapshot.
  expect(row([])).toContain('data-testid="folder-suggestion"')
  const filed = row([suggested])
  expect(filed).toContain('data-testid="past-note-folder"')
  expect(filed).not.toContain('data-testid="folder-suggestion"')
  state.mine = []
  expect(row([suggested])).toBe(filed)
})

it('switches the note straight from the suggestion to its normal folder chip', () => {
  expect(chip()).toContain('data-testid="folder-suggestion"')
  state.mine = [suggested]
  const filed = chip()
  expect(filed).toContain('data-testid="note-folders"')
  expect(filed).toContain(`>${suggested.name}</span>`)
  expect(filed).not.toContain('data-testid="folder-suggestion"')
  expect(filed).not.toContain('Add to folder</span>')
})

it('puts the suggested folder first without selecting it or changing the normal picker order', () => {
  const picker = (suggestedId?: string) => renderToStaticMarkup(createElement(FolderPicker, { meetingId: 'meeting', suggestedId, testId: 'picker', onNew() {} }))
  const html = picker(suggested.id)
  expect(html.indexOf(suggested.name)).toBeLessThan(html.indexOf('Alpha'))
  expect(html).toContain('>Suggested</span>')
  expect(html.match(/aria-checked="false"/g)).toHaveLength(2)
  const normal = picker()
  expect(normal.indexOf('Alpha')).toBeLessThan(normal.indexOf(suggested.name))
  expect(normal).not.toContain('>Suggested</span>')
})

it('keeps the meeting link then More before any folder controls in DOM tab order', () => {
  for (const folders of [[], [alpha], [alpha, suggested]]) {
    const card: MeetingCard = { id: 'meeting', title: 'Budget review', state: 'done', startedAt: 1, endedAt: 2, preview: '', eventId: null, app: null, language: null, titleSource: 'user', attendees: [], folders }
    const html = renderToStaticMarkup(createElement(PastNotes, { cards: [card], day: '', more: false, sentinel() {}, onOpen() {} }))
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map(match => match[0])
    expect(buttons[0]).toContain('class="native-meeting-link"')
    expect(buttons[1]).toContain('data-testid="past-note-more"')
    expect(buttons.slice(2)).toHaveLength(folders.length)
    for (const button of buttons.slice(2)) expect(button).toContain('data-testid="past-note-folder"')
    for (const button of buttons) expect(button).not.toMatch(/disabled|tabindex/)
  }
})
