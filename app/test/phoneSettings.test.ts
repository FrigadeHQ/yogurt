import { createElement, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PhoneSettings } from '../src/renderer/src/components/PhoneSettings'
import { LOCALES, setLanguage, t } from '../src/shared/i18n'
import type { CompanionStatus } from '../src/shared/companion'

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: vi.fn() }))
const NOW = Date.UTC(2026, 10, 20, 12)
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); setLanguage('en') })

const idle: CompanionStatus = { paired: null, pairing: null, pairingClosed: null, error: null, connected: false, syncing: false }
const WIFI = 'Your iPhone talks to this computer only on the same Wi-Fi. Nothing goes through the internet.'

/** renders with this status; `extra` are the next useState values after it (failed, busy, confirming) */
async function render(status: CompanionStatus | null, ...extra: unknown[]) {
  const react = await vi.importActual<typeof import('react')>('react')
  const mock = vi.mocked(useState).mockImplementation(react.useState).mockImplementationOnce(() => [status, vi.fn()])
  for (const v of extra) mock.mockImplementationOnce(() => [v, vi.fn()])
  return renderToStaticMarkup(createElement(PhoneSettings)).replace(/<!-- -->/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
}

it('not paired: explains it and offers Pair a phone, with the Wi-Fi note', async () => {
  const html = await render(idle)
  expect(html).toContain('Phone')
  expect(html).toContain('data-testid="phone-pair"')
  expect(html).toContain('Pair a phone')
  expect(html).toContain(WIFI)
  expect(html).not.toContain('Unpair')
})

it('pairing: the six digits large in two groups, what to do with them, a countdown and Cancel', async () => {
  const html = await render({ ...idle, pairing: { code: '482913', expiresAt: NOW + 102_000, attemptsLeft: 5 } })
  expect(html).toMatch(/data-testid="phone-code"[^>]*>.*482.*913/)
  expect(html).toContain('Open Yogurt on your iPhone and type this code')
  expect(html).toContain('Code works for 1:42')
  expect(html).toContain('data-testid="phone-cancel"')
  expect(html).toContain(WIFI)
  expect(html).not.toContain('data-testid="phone-pair"')
})

it('closed pairing and failures say why, and offer to start again', async () => {
  for (const [s, text] of [
    [{ ...idle, pairingClosed: 'tooMany' }, 'Too many wrong codes. Start pairing again.'],
    [{ ...idle, pairingClosed: 'expired' }, 'The code ran out. Start pairing again.'],
    [{ ...idle, error: 'listen' }, "Yogurt couldn't start pairing. Try again."],
  ] as const) {
    const html = await render(s as CompanionStatus)
    expect(html).toContain(text)
    expect(html).toContain('data-testid="phone-pair"')
  }
  // a start that failed without a reason from the companion
  expect(await render(idle, true)).toContain("Yogurt couldn't start pairing. Try again.")
})

it('a keychain that will not open says so and offers no pairing', async () => {
  const html = await render({ ...idle, error: 'keychain' })
  expect(html).toContain("Yogurt couldn't reach this computer's secure storage, so it can't pair right now.")
  expect(html).not.toContain('data-testid="phone-pair"')
})

it('paired: the phone, Connected or when it was last seen, and Unpair with an inline confirm', async () => {
  const connected = await render({ ...idle, paired: { name: 'Test iPhone', lastSeen: NOW }, connected: true })
  expect(connected).toContain('Test iPhone')
  expect(connected).toContain('Connected')
  expect(connected).toContain('phone-live-dot')
  expect(connected).toContain('data-testid="phone-unpair"')
  const away = await render({ ...idle, paired: { name: 'Test iPhone', lastSeen: NOW - 2 * 3600_000 } })
  expect(away).toMatch(/Last seen 2\s?h(r\.?)? ago/)
  expect(away).not.toContain('phone-live-dot')
  const confirming = await render({ ...idle, paired: { name: 'Test iPhone', lastSeen: NOW } }, false, false, true)
  expect(confirming).toContain('Unpair your iPhone? It keeps its copy until you pair again.')
  expect(confirming).toContain('data-testid="phone-unpair-confirm"')
  // a paired phone this computer can't listen for says so
  expect(await render({ ...idle, paired: { name: 'Test iPhone', lastSeen: NOW }, error: 'listen' })).toContain('data-testid="phone-notice"')
})

const MAC_NETWORK = "Your iPhone can't see this computer. Allow Local Network for Yogurt in System Settings → Privacy & Security."
const PC_NETWORK = "Your iPhone can't see this computer. Allow Yogurt through your firewall on private networks."

it('an advert the network refused says how to let the iPhone see this computer, while pairing and once paired', async () => {
  vi.stubGlobal('window', { yogurt: { platform: 'darwin' } })
  try {
    const pairing = await render({ ...idle, error: 'network', pairing: { code: '482913', expiresAt: NOW + 102_000, attemptsLeft: 5 } })
    expect(pairing).toContain(MAC_NETWORK)
    expect(pairing).toContain('data-testid="phone-code"')
    expect(await render({ ...idle, error: 'network', paired: { name: 'Test iPhone', lastSeen: NOW } })).toContain(MAC_NETWORK)
    vi.stubGlobal('window', { yogurt: { platform: 'win32' } })
    expect(await render({ ...idle, error: 'network', paired: { name: 'Test iPhone', lastSeen: NOW } })).toContain(PC_NETWORK)
  } finally { vi.unstubAllGlobals() }
})

it('shows nothing when the companion is not running', async () => {
  expect(await render(null)).toBe('')
})

it('translates the Phone section in every interface language', () => {
  for (const { id } of LOCALES) {
    setLanguage(id)
    for (const key of ['Phone', 'Pair a phone', 'Open Yogurt on your iPhone and type this code', WIFI, 'Unpair your iPhone? It keeps its copy until you pair again.', MAC_NETWORK, PC_NETWORK]) {
      expect(t(key).trim()).not.toBe('')
      if (id !== 'en') expect(t(key)).not.toBe(key)
    }
  }
})
