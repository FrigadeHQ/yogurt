import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { installFocusNavigation } from '../src/renderer/src/focusNavigation'

class Control {
  readonly attributes = new Set<string>()
  isConnected = true
  parentElement?: Control
  constructor(readonly surface?: Control, readonly textField = false) {}
  closest(selector: string): Control | null {
    if (selector.startsWith('dialog')) return this.surface ?? (this.attributes.has('surface') ? this : null)
    return this.textField ? this : null
  }
  matches(selector: string) { return selector.includes('.search-backdrop') && this.attributes.has('backdrop') }
  hasAttribute(name: string) { return this.attributes.has(name) }
  setAttribute(name: string) { this.attributes.add(name) }
  removeAttribute(name: string) { this.attributes.delete(name) }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

function fixture() {
  vi.useFakeTimers()
  vi.stubGlobal('Element', Control)
  const body = new Control()
  const doc = Object.assign(new EventTarget(), { documentElement: new Control(), body, activeElement: body })
  const stop = installFocusNavigation(doc as unknown as Document)
  function event(type: string, target: Control, props = {}) {
    if (type === 'focus') doc.activeElement = target
    const e = Object.assign(new Event(type), props)
    Object.defineProperty(e, 'target', { value: target })
    doc.dispatchEvent(e)
    vi.runOnlyPendingTimers()
  }
  return { body, event, stop }
}

it.each([false, true])('restores the original search opener after typing and navigating inside (keyboard %s)', keyboard => {
  const { body, event, stop } = fixture()
  const opener = new Control(), input = new Control(new Control())
  event(keyboard ? 'keydown' : 'pointerdown', keyboard ? body : opener, { key: 'Tab' })
  event('focus', opener)
  event('keydown', opener, { key: 'k', metaKey: true })
  event('focus', input)
  event('keydown', input, { key: 's' })
  event('keydown', input, { key: 'ArrowDown' })
  expect(input.attributes.has('data-focus-ring')).toBe(true)
  event('keydown', input, { key: 'Escape' })
  event('focus', opener)
  expect(opener.attributes.has('data-focus-ring')).toBe(keyboard)
  expect(opener.attributes.has('data-quiet-focus')).toBe(!keyboard)
  expect(input.attributes.size).toBe(0)
  event('keydown', opener, { key: 'Tab', shiftKey: true })
  expect(opener.attributes.has('data-focus-ring')).toBe(true)
  stop()
  expect(opener.attributes.size).toBe(0)
})

it('retains each opener across nested menus and ignores typing, activation and dismissal', () => {
  const { event, stop } = fixture()
  const opener = new Control(), item = new Control(new Control()), action = new Control(new Control())
  event('pointerdown', opener)
  event('focus', opener)
  event('focus', item)
  for (const key of ['a', 'Enter', 'Escape']) {
    event('keydown', item, { key })
    expect(item.attributes.has('data-quiet-focus')).toBe(true)
  }
  event('keydown', item, { key: 'ArrowDown' })
  event('focus', action)
  event('pointerdown', action)
  event('focus', item)
  expect(item.attributes.has('data-focus-ring')).toBe(true)
  event('focus', opener)
  expect(opener.attributes.has('data-quiet-focus')).toBe(true)
  event('blur', opener)
  expect(opener.attributes.size).toBe(0)
  stop()
})

it('keeps a keyboard opener visible when the backdrop is clicked', () => {
  const { body, event, stop } = fixture()
  const opener = new Control(), input = new Control(new Control()), backdrop = new Control()
  backdrop.setAttribute('backdrop')
  event('keydown', body, { key: 'Tab' })
  event('focus', opener)
  event('focus', input)
  event('pointerdown', backdrop)
  event('focus', opener)
  expect(opener.attributes.has('data-focus-ring')).toBe(true)
  stop()
})

it('keeps caret movement quiet and restores a previously unfocused containing screen', () => {
  const { body, event, stop } = fixture()
  const route = new Control(), panel = new Control()
  route.setAttribute('surface')
  panel.parentElement = new Control(route)
  const textarea = new Control(panel, true), trigger = new Control(route)
  event('keydown', body, { key: 'j', metaKey: true })
  event('focus', textarea)
  event('keydown', textarea, { key: 'ArrowLeft' })
  expect(textarea.attributes.has('data-quiet-focus')).toBe(true)
  event('keydown', textarea, { key: 'Tab' })
  expect(textarea.attributes.has('data-focus-ring')).toBe(true)
  const guard = new Control()
  guard.setAttribute('data-base-ui-focus-guard')
  event('focus', guard)
  event('keydown', textarea, { key: 'Escape' })
  event('focus', trigger)
  expect(trigger.attributes.has('data-quiet-focus')).toBe(true)
  stop()
})

it('reveals the focused action and clears overlapping metadata even when the focus ring is quiet', () => {
  const style = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
  const workspace = readFileSync(new URL('../src/renderer/src/workspace.css', import.meta.url), 'utf8')
  expect(style).toMatch(/\.person-remove:focus\s*\{\s*opacity:\s*1;/)
  expect(workspace).toMatch(/\.workspace-folder-more:focus,[^{]*\{ opacity:1;/)
  expect(workspace).toMatch(/:has\(\.workspace-folder-more:focus,[^{]* small \{ visibility:hidden;/)
  expect(workspace).toMatch(/\.meeting-delete:focus \{ opacity:1;/)
  expect(workspace).toMatch(/\.row-swap-actions:focus-within[^{]* \.row-swap-actions \{ opacity:1;pointer-events:auto;/)
  expect(workspace).toMatch(/\.row-swap-actions:focus-within[^{]* \.row-swap-meta \{ opacity:0;pointer-events:none;/)
  expect(style).toMatch(/\.note-resume-action:is\(:hover,:focus\) \.summary-stop-square \{ opacity:1;/)
  expect(style).toMatch(/:focus-within\) \.chat-answer-actions \{ opacity:1;/)
})
