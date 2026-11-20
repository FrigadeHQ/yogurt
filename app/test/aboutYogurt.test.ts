import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { AboutYogurt } from '../src/renderer/src/components/AboutYogurt'
import { setLanguage } from '../src/shared/i18n'

afterEach(() => { vi.unstubAllGlobals(); setLanguage('en') })

it.each(['darwin', 'win32', 'linux'])('offers the native picker only on Mac (%s)', os => {
  setLanguage('en')
  vi.stubGlobal('window', { yogurt: { os } })
  const html = renderToStaticMarkup(createElement(AboutYogurt))
  expect(html.includes('aria-haspopup="menu"')).toBe(os === 'darwin')
  expect(html).toContain('aria-label="Copy link"')
  expect(html).toContain('data-widest="Copied"')
  expect(html).toContain('href="https://github.com/FrigadeHQ/yogurt"')
  expect(html).toContain('prefers-color-scheme: dark')
})
