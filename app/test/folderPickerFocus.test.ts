import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createElement, useEffect, useLayoutEffect, useRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Folder } from '../src/shared/types'
import { FolderChip, FolderPicker } from '../src/renderer/src/components/FolderPicker'

const state = vi.hoisted(() => ({ all: undefined as Folder[] | undefined }))
vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>()
  return { ...react, useEffect: vi.fn(), useLayoutEffect: vi.fn(), useRef: vi.fn(react.useRef) }
})
vi.mock('../src/renderer/src/folders', () => ({ useFolderRead: () => ({ folders: [] }), useFolders: (id?: string) => id ? [] : state.all, setMeetingsInFolder: vi.fn() }))
vi.mock('../src/renderer/src/components/TrashToast', () => ({ toasts: { add: vi.fn(), close: vi.fn() } }))
vi.mock('../src/renderer/src/motion', () => ({ useReducedMotion: () => false, usePopoverPresence: () => ({ value: false, props: {} }) }))
afterEach(() => vi.unstubAllGlobals())
const alpha: Folder = { id: 'alpha', name: 'Alpha', icon: 'folder', color: 'default', count: 0, createdAt: 1 }
const suggested: Folder = { ...alpha, id: 'suggested', name: 'Suggested folder' }
beforeEach(() => { vi.clearAllMocks(); state.all = undefined })

// Exercise the effect against its rendered first item without a browser or a new DOM dependency.
function picker(autoFocus = true, suggestedId?: string) {
  vi.clearAllMocks()
  const html = renderToStaticMarkup(createElement(FolderPicker, { meetingId: 'meeting', testId: 'picker', onNew() {}, autoFocus, suggestedId }))
  const first = html.match(/<button\b[\s\S]*?<\/button>/)![0]
  const focus = vi.fn()
  // the suggested folder is marked in place; without one, the first option is focused
  const querySelector = vi.fn((selector: string) => (selector === '[data-suggested]' ? (suggestedId && html.includes('data-suggested') ? { focus } : null) : { focus }))
  vi.mocked(useRef).mock.results[0].value.current = { querySelector }
  const [effect, dependencies] = vi.mocked(useEffect).mock.calls[0]
  return { first, focus, querySelector, effect, dependencies }
}

it.each([undefined, 'suggested'])('waits for folders, then focuses the suggested folder where it sits, else the first option (suggestion: %s)', suggestedId => {
  const loading = picker(true, suggestedId)
  loading.effect()
  expect(loading.focus).not.toHaveBeenCalled()
  state.all = [alpha, suggested]
  const ready = picker(true, suggestedId)
  expect(ready.dependencies).not.toEqual(loading.dependencies)
  ready.effect()
  if (suggestedId) expect(ready.querySelector).toHaveBeenCalledWith('[data-suggested]')
  else expect(ready.querySelector).toHaveBeenCalledWith('[role="menuitemcheckbox"], [role="menuitem"]')
  // the list keeps its order: the suggestion is not moved to the top
  expect(ready.first).toContain(`>${alpha.name}</span>`)
  expect(ready.focus).toHaveBeenCalledOnce()
  state.all = [alpha, { ...suggested, count: 1 }]
  // Membership refreshes must not retrigger focus while the user navigates the menu.
  expect(picker(true, suggestedId).dependencies).toEqual(ready.dependencies)
})

it('focuses New folder for an empty loaded list, and leaves other menu owners in control', () => {
  state.all = []
  const empty = picker()
  empty.effect()
  expect(empty.first).toContain('data-testid="folder-new"')
  expect(empty.focus).toHaveBeenCalledOnce()
  const owned = picker(false)
  owned.effect()
  expect(owned.focus).not.toHaveBeenCalled()
})

it.each([false, true])('restores suggestion focus after the replacement DOM commits without stealing focus (row: %s)', row => {
  renderToStaticMarkup(createElement(FolderChip, { meetingId: 'meeting', row, rowFolders: [], suggestion: { folder: suggested, dismiss() {} } }))
  const refs = vi.mocked(useRef).mock.results.map(result => result.value)
  const oldTarget = { focus: vi.fn() }, replacement = { focus: vi.fn() }, body = {}
  refs[1].current = replacement
  refs[2].current = oldTarget
  const commit = vi.mocked(useLayoutEffect).mock.calls[0][0]
  vi.stubGlobal('document', { body, activeElement: body })
  commit()
  expect((row ? oldTarget : replacement).focus).toHaveBeenCalledOnce()
  expect((row ? replacement : oldTarget).focus).not.toHaveBeenCalled()
  commit()
  expect((row ? oldTarget : replacement).focus).toHaveBeenCalledOnce()
  refs[2].current = oldTarget
  vi.stubGlobal('document', { body, activeElement: {} })
  commit()
  expect((row ? oldTarget : replacement).focus).toHaveBeenCalledOnce()
})
