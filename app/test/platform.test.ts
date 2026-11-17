import { describe, expect, it } from 'vitest'
import { capabilities, commandKey, helperFile, micListHelper, platformOf, shortcutLabel, supportedKinds, settingsPage } from '../src/shared/platform'
import { PERMISSION_KINDS } from '../src/main/permissions'

describe('what each computer can do', () => {
  it('a Mac has every feature, exactly as before', () => {
    expect(capabilities('darwin')).toEqual({ calendar: true, calendarLink: false, callNames: true, permissionPrompts: true, mediaPause: true })
  })
  it('Windows and Linux have a calendar through a calendar link (no system calendar to ask), and names from calls', () => {
    expect(capabilities('win32')).toEqual({ calendar: true, calendarLink: true, callNames: true, permissionPrompts: false, mediaPause: false })
    expect(capabilities('linux')).toEqual({ calendar: true, calendarLink: true, callNames: true, permissionPrompts: false, mediaPause: false })
  })
  it('only fake mode can pretend to be another computer, so the Mac CI can try the Windows and Linux screens', () => {
    expect(platformOf('darwin', { YOGURT_FAKE: '1', YOGURT_FAKE_PLATFORM: 'win32' })).toBe('win32')
    expect(platformOf('darwin', { YOGURT_FAKE: '1', YOGURT_FAKE_PLATFORM: 'linux' })).toBe('linux')
    expect(platformOf('darwin', { YOGURT_FAKE_PLATFORM: 'win32' })).toBe('darwin')
    expect(platformOf('darwin', { YOGURT_FAKE: '1', YOGURT_FAKE_PLATFORM: 'beos' })).toBe('darwin')
    expect(platformOf('linux', {})).toBe('linux')
  })
})

describe('helper programs', () => {
  it('a Mac keeps its helpers names', () => {
    expect(['system', 'audio', 'mcp', 'whisper'].map((h) => helperFile(h as never, 'darwin'))).toEqual(['yogurt-mac', 'yogurt-audio', 'yogurt-mcp', 'whisper-server'])
  })
  it('Windows and Linux get yogurt-system in place of yogurt-mac, and .exe on Windows', () => {
    expect(['system', 'audio', 'mcp', 'whisper'].map((h) => helperFile(h as never, 'linux'))).toEqual(['yogurt-system', 'yogurt-audio', 'yogurt-mcp', 'whisper-server'])
    expect(['system', 'audio', 'mcp', 'whisper'].map((h) => helperFile(h as never, 'win32'))).toEqual(['yogurt-system.exe', 'yogurt-audio.exe', 'yogurt-mcp.exe', 'whisper-server.exe'])
  })
})

describe('the mic list', () => {
  it("comes from yogurt-mac on a Mac and from the recorder itself on Windows and Linux", () => {
    expect(['darwin', 'win32', 'linux'].map(micListHelper)).toEqual(['system', 'audio', 'audio'])
  })
})

describe('permissions to ask for', () => {
  it('a Mac asks for every one, in the same order', () => {
    expect(supportedKinds(capabilities('darwin'))).toEqual(PERMISSION_KINDS)
  })
  it('without a calendar, it is never asked', () => {
    expect(supportedKinds(capabilities('win32'))).toEqual(['mic', 'systemAudio', 'notifications', 'accessibility'])
  })
  it('Windows and Linux keep accessibility in the list (they have no prompt for it)', () => {
    expect(supportedKinds(capabilities('linux'))).toEqual(['mic', 'systemAudio', 'notifications', 'accessibility'])
  })
})

describe('shortcuts', () => {
  it('a Mac keeps its own signs, exactly as written', () => {
    for (const k of ['⌘K', '⇧⌘C', '⌃⌘S', '⌥⇧⌘V', '⌃⌘F', '⌘−', '↑ ↓', 'esc']) expect(shortcutLabel(k, 'darwin')).toBe(k)
  })
  it('Windows and Linux write Ctrl, Shift and Alt, in that order', () => {
    for (const p of ['win32', 'linux']) {
      expect(['⌘K', '⌘,', '⇧⌘C', '⇧⌘Z', '⌥F10', '⌘−', '↑ ↓', '↵', 'esc'].map((k) => shortcutLabel(k, p)))
        .toEqual(['Ctrl+K', 'Ctrl+,', 'Ctrl+Shift+C', 'Ctrl+Shift+Z', 'Alt+F10', 'Ctrl+−', '↑ ↓', '↵', 'esc'])
    }
  })
  it("Windows and Linux use their own keys where a Mac's would mean something else", () => {
    expect(['⌃⌘S', '⌃⌘F', '⌥⇧⌘V'].map((k) => shortcutLabel(k, 'win32'))).toEqual(['Ctrl+Shift+S', 'F11', 'Ctrl+Shift+V'])
  })
  it('the command key is ⌘ on a Mac and Ctrl elsewhere', () => {
    const key = (metaKey: boolean, ctrlKey: boolean) => ({ metaKey, ctrlKey })
    expect([key(true, false), key(false, true)].map((e) => commandKey(e, 'darwin'))).toEqual([true, false])
    expect([key(true, false), key(false, true), key(true, true)].map((e) => commandKey(e, 'win32'))).toEqual([false, true, false])
  })
})

describe('settingsPage: a permission row offers Manage only where the computer has a page to open (#70)', () => {
  it('a Mac opens System Settings for every one', () => {
    for (const k of ['mic', 'systemAudio', 'calendar', 'notifications', 'accessibility'] as const) expect(settingsPage('darwin', k)).toBe(true)
  })
  it('Windows has pages for the mic, sound and notifications, none for names from calls', () => {
    expect(settingsPage('win32', 'mic')).toBe(true)
    expect(settingsPage('win32', 'systemAudio')).toBe(true)
    expect(settingsPage('win32', 'notifications')).toBe(true)
    expect(settingsPage('win32', 'accessibility')).toBe(false)
  })
  it('Linux has none to open', () => {
    for (const k of ['mic', 'systemAudio', 'notifications', 'accessibility'] as const) expect(settingsPage('linux', k)).toBe(false)
  })
})

describe('settingsPage agrees with the links main opens', () => {
  it('Windows rows offer Manage exactly where main has a link', async () => {
    const { WINDOWS_SETTINGS } = await import('../src/main/permissions')
    for (const k of PERMISSION_KINDS) expect(settingsPage('win32', k)).toBe(!!WINDOWS_SETTINGS[k])
  })
})
