import { createElement, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { phoneCompanionOn } from '../src/shared/companion'
import { companionWanted } from '../src/main/companion/gate'
import { PhoneSettings } from '../src/renderer/src/components/PhoneSettings'
import type { CompanionStatus } from '../src/shared/companion'

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: vi.fn() }))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const paired: CompanionStatus = { paired: { name: 'Test iPhone', lastSeen: 1 }, pairing: null, pairingClosed: null, error: null, connected: false, syncing: false }

it.each(['darwin', 'win32', 'linux'] as const)('shows iPhone settings on %s only on Mac or with the override', platform => {
  const mac = platform === 'darwin'
  expect(phoneCompanionOn({}, platform)).toBe(mac)
  expect(phoneCompanionOn({ YOGURT_PHONE: '0' }, platform)).toBe(mac)
  expect(phoneCompanionOn({ YOGURT_PHONE: '1' }, platform)).toBe(true)
  expect(companionWanted({}, false, platform)).toBe(mac)
  expect(companionWanted({}, true, platform)).toBe(false)
  expect(companionWanted({ YOGURT_FAKE_COMPANION: '1' }, true, platform)).toBe(mac)
  expect(companionWanted({ YOGURT_PHONE: '1', YOGURT_FAKE_COMPANION: '1' }, true, platform)).toBe(true)
})

it('with the flag off Settings shows no Phone section, even for a paired phone', async () => {
  const react = await vi.importActual<typeof import('react')>('react')
  vi.mocked(useState).mockImplementation(react.useState).mockImplementationOnce(() => [paired, vi.fn()])
  vi.stubGlobal('window', { yogurt: { phone: false } })
  expect(renderToStaticMarkup(createElement(PhoneSettings))).toBe('')
  vi.stubGlobal('window', { yogurt: { phone: true } })
  vi.mocked(useState).mockImplementation(react.useState).mockImplementationOnce(() => [paired, vi.fn()])
  expect(renderToStaticMarkup(createElement(PhoneSettings))).toContain('data-testid="phone-settings"')
})
