import { createElement, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { PHONE_COMPANION, phoneCompanionOn } from '../src/shared/companion'
import { companionWanted } from '../src/main/companion/gate'
import { PhoneSettings } from '../src/renderer/src/components/PhoneSettings'
import type { CompanionStatus } from '../src/shared/companion'

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: vi.fn() }))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const paired: CompanionStatus = { paired: { name: 'Test iPhone', lastSeen: 1 }, pairing: null, pairingClosed: null, error: null, connected: false, syncing: false }

it('the iPhone companion is off until the iPhone app ships; YOGURT_PHONE=1 turns it on', () => {
  expect(PHONE_COMPANION).toBe(false)
  expect(phoneCompanionOn({})).toBe(false)
  expect(phoneCompanionOn({ YOGURT_PHONE: '0' })).toBe(false)
  expect(phoneCompanionOn({ YOGURT_PHONE: '1' })).toBe(true)
})

it('with the flag off the companion never starts, so nothing listens or advertises, paired phone or not', () => {
  expect(companionWanted({}, false)).toBe(false)
  expect(companionWanted({ YOGURT_FAKE_COMPANION: '1' }, true)).toBe(false)
  // on: a real app starts it; fake mode only when a test asks
  expect(companionWanted({ YOGURT_PHONE: '1' }, false)).toBe(true)
  expect(companionWanted({ YOGURT_PHONE: '1' }, true)).toBe(false)
  expect(companionWanted({ YOGURT_PHONE: '1', YOGURT_FAKE_COMPANION: '1' }, true)).toBe(true)
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
