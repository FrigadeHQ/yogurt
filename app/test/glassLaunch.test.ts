import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { App } from '../src/renderer/src/App'
import { MacLaunch } from '../src/renderer/src/components/BootScreen'
import { MARK, MARK_FIT } from '../src/shared/logo'
import { BOOT } from '../src/shared/onboarding'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function startup(platform: string, elapsed: number) {
  vi.stubGlobal('window', { innerWidth: 1100, yogurt: { platform } })
  vi.spyOn(performance, 'now').mockReturnValue(elapsed)
  return renderToStaticMarkup(createElement(App))
}

it('exposes the Mac material with one still Yogurt mark after the existing startup delay', () => {
  expect(startup('darwin', BOOT.showAfterMs - 1)).not.toContain('<svg')
  const html = startup('darwin', BOOT.showAfterMs)
  expect(html).toContain('class="mac-launch" data-active="true"')
  expect(html).toContain('data-testid="app-shell" inert=""')
  expect(html).toContain('width="52" height="52"')
  expect(html).toContain(`d="${MARK}" fill="currentColor" transform="${MARK_FIT}"`)
  expect(html).toContain('text-neutral-400 dark:text-white')
  expect(html).not.toMatch(/boot-band|linearGradient/)
  const done = renderToStaticMarkup(createElement(MacLaunch, { active: false }))
  expect(done).toContain('aria-hidden="true"')
  expect(done).not.toMatch(/data-active|data-testid="boot-screen"/)
})

it.each(['win32', 'linux'])('keeps the existing solid launch on %s', os => {
  const html = startup(os, BOOT.showAfterMs)
  expect(html).toContain('class="boot-screen"')
  expect(html).toContain('class="boot-band"')
  expect(html).toContain(`d="${MARK}" transform="${MARK_FIT}" clip-rule="evenodd"`)
  expect(html).not.toMatch(/mac-launch|inert=""/)
})

it('positions the mark at 49% and gates the handoff on both accessibility preferences', () => {
  const css = readFileSync(new URL('../src/renderer/src/setup.css', import.meta.url), 'utf8')
  expect(css).toMatch(/\.mac-launch-mark \{[^}]*translate:0 -1vh/)
  expect(css).toMatch(/@media \(prefers-reduced-transparency:reduce\)\s*\{\s*\.mac-launch,[^{]+\{ background:var\(--bg\)/)
  expect(css).toMatch(/@media \(prefers-reduced-motion:no-preference\) and \(prefers-reduced-transparency:no-preference\)\s*\{\s*\.mac-launch:not\(\[data-active\]\) \{[^}]+\}\s*\.mac-launch:not\(\[data-active\]\) \+ \.app-shell \{ transition:opacity var\(--dur-base\)/)
})
