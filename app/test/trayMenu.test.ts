import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { formatTrayTime, hasTrayHost, nextTrayEvent, trayItems, trayLook, trayTitle } from '../src/main/trayMenu'
import { setLanguage } from '../src/shared/i18n'
const now = new Date(2026, 10, 9, 13).getTime()
const event = { id: 'event', title: 'Launch planning', start: now + 3600000, end: now + 7200000, attendees: [], url: 'https://example.com/call' }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); setLanguage('en') })
afterEach(() => vi.useRealTimers())
it('idle has recording, Ask, disabled empty Recent and navigation in the approved order', () => {
  const items = trayItems(null)
  expect(items.map(i => i.id)).toEqual(['new', 'ask', 'recent', 'sep', 'open', 'settings', 'sep', 'quit'])
  expect(items.find(i => i.id === 'recent')).toMatchObject({ enabled: false, submenu: [] })
  expect(items.find(i => i.id === 'settings')?.accelerator).toBe('Command+,')
})
it('picks an ongoing meeting first and offers Join for a same-day call', () => {
  const personal = { ...event, attendees: [], url: null }
  expect(nextTrayEvent([personal], now)).toBeUndefined()
  expect(nextTrayEvent([{ ...event, end: now }], now)).toBeUndefined()
  expect(nextTrayEvent([event, { ...event, id: 'live', start: now - 1000 }], now)?.id).toBe('live')
  expect(trayItems(null, event).slice(0, 2).map(i => i.id)).toEqual(['next', 'join'])
  expect(trayItems(null, event)[0].label).toBe('Launch planning · 2:00 PM')
  const live = { ...event, start: now - 1000, url: null, attendees: [{ name: 'Dana', email: 'dana@example.com' }] }
  expect(trayItems(null, live)[0].label).toBe('Now · Launch planning')
  expect(trayItems(null, live).some(i => i.id === 'join')).toBe(false)
})
it('recording has pause and Stop; paused has Resume; neither shows next meeting or Start', () => {
  for (const paused of [false, true]) {
    const items = trayItems({ title: 'Standup', paused }, event)
    expect(items.map(i => i.id)).toEqual(['status', 'pause', 'stop', 'sep', 'ask', 'open', 'recent', 'settings', 'sep', 'quit'])
    expect(items[0]).toMatchObject({ enabled: false, label: `${paused ? 'Paused' : 'Recording'} · Standup` })
    expect(items[1].label).toBe(paused ? 'Resume recording' : 'Pause recording')
    expect(items[2].label).toBe('Stop recording')
  }
})
it('Recent keeps the last five by start, with reusable dates and note targets', () => {
  const recent = Array.from({ length: 7 }, (_, i) => ({ id: String(i), title: `Note ${i}`, startedAt: now - i * 86400000 })).reverse()
  const submenu = trayItems(null, undefined, recent).find(i => i.id === 'recent')!.submenu!
  expect(submenu).toHaveLength(5)
  expect(submenu[0]).toMatchObject({ id: 'note:0', label: 'Note 0 · Today' })
  expect(submenu[1].label).toBe('Note 1 · Yesterday')
  expect(submenu[4].label).toBe('Note 4 · Nov 5')
})
it('formats the running timer and names the paused state', () => {
  expect(trayTitle(null)).toBe('')
  expect(trayTitle({ elapsedMs: 723999, paused: false })).toBe('12:03')
  expect(trayTitle({ elapsedMs: 723999, paused: true })).toBe('Paused')
  expect(trayTitle({ elapsedMs: 3661000, paused: false })).toBe('1:01:01')
})

describe('Windows and Linux tray', () => {
  it('Settings shows Ctrl there and ⌘ on a Mac', () => {
    const settings = (os?: string) => trayItems(null, undefined, [], Date.now(), os).find(i => i.id === 'settings')?.accelerator
    expect([settings(), settings('darwin'), settings('win32'), settings('linux')]).toEqual(['Command+,', 'Command+,', 'Ctrl+,', 'Ctrl+,'])
  })
  it('a Mac keeps its template icon and timer title', () => {
    expect(trayLook('darwin', null, 0)).toEqual({ icon: 'tray', template: true, title: '', tooltip: 'Yogurt' })
    expect(trayLook('darwin', { paused: false }, 723000)).toEqual({ icon: 'tray-titled', template: true, title: '12:03', tooltip: 'Yogurt is recording' })
    expect(trayLook('darwin', { paused: true }, 723000)).toEqual({ icon: 'tray-titled', template: true, title: 'Paused', tooltip: 'Recording paused' })
  })
  it('elsewhere a colour icon, a recording one while it records, and the time in the tooltip (no title there)', () => {
    for (const os of ['win32', 'linux']) {
      expect(trayLook(os, null, 0)).toEqual({ icon: 'tray-color', template: false, title: null, tooltip: 'Yogurt' })
      expect(trayLook(os, { paused: false }, 723000)).toEqual({ icon: 'tray-recording', template: false, title: null, tooltip: '● 12:03' })
      expect(trayLook(os, { paused: true }, 723000)).toEqual({ icon: 'tray-color', template: false, title: null, tooltip: 'Paused' })
    }
  })
  it('Linux has a tray only when a StatusNotifier host answers (GNOME needs its AppIndicator extension)', () => {
    expect(hasTrayHost('method return time=1 sender=org.freedesktop.DBus\n   boolean true\n')).toBe(true)
    expect(hasTrayHost('method return\n   boolean false\n')).toBe(false)
    expect(hasTrayHost('')).toBe(false)
  })
})

describe('idle meeting title', () => {
  const min = 60_000
  it.each([
    [360, '7:00 PM'], [121, '3:01 PM'], [83, '2:23 PM'], [60 + 1 / 60, '2:00 PM'], [60, 'in 1h'], [30, 'in 30m'],
    [5, 'in 5m'], [1, 'in 1m'], [1 / 60, 'in 1m'], [0, 'Now'], [-29, 'Now'], [-30, ''],
  ] as const)('%s minutes until the meeting', (offset, when) => {
    const start = now + offset * min
    const next = nextTrayEvent([{ ...event, start, end: start + 30 * min }], now)
    const line = when === 'Now' ? 'Now · Launch planning' : when ? `Launch planning · ${when}` : ''
    expect(trayLook('darwin', null, 0, next, now)).toMatchObject({ title: line, icon: line ? 'tray-titled' : 'tray' })
    for (const os of ['linux', 'win32']) {
      const look = trayLook(os, null, 0, next, now)
      expect(look.title).toBeNull()
      expect(look.tooltip).toBe(line || trayLook(os, null, 0).tooltip)
    }
  })

  it('shows the next date after the last meeting ends, through the seventh local date', () => {
    const at = new Date(2026, 10, 19, 17, 15).getTime()
    const meeting = (day: number, hour: number) => {
      const start = new Date(2026, 10, day, hour).getTime()
      return { ...event, title: 'Quarterly review', start, end: start + 30 * min }
    }
    const ended = meeting(19, 16), tomorrow = meeting(20, 9), monday = meeting(23, 14)
    const last = meeting(26, 23), outside = meeting(27, 0)
    expect(nextTrayEvent([ended, outside], at)).toBeUndefined()
    expect(nextTrayEvent([outside, last], at)).toBe(last)
    expect(nextTrayEvent([last, monday], at)).toBe(monday)
    const next = nextTrayEvent([monday, ended, tomorrow], at)
    for (const os of ['darwin', 'linux', 'win32']) {
      const look = trayLook(os, null, 0, next, at)
      expect(look.title ?? look.tooltip).toBe('Quarterly review · Nov 20 9:00 AM')
    }
    const menu = trayItems(null, next, [], at)
    expect(menu[0]).toMatchObject({ id: 'next', label: 'Quarterly review · Nov 20 9:00 AM', enabled: false })
    expect(menu.some(item => item.id === 'join')).toBe(false)
    expect(trayTitle(null, { ...monday, title: 'W'.repeat(40) }, at)).toBe('W'.repeat(21) + '… · Nov 23 2:00 PM')
  })

  it('keeps a meeting that started yesterday until its actual end', () => {
    const at = new Date(2026, 10, 20, 0, 5).getTime()
    const overnight = { ...event, start: at - 15 * min, end: at + 5 * min }
    expect(trayTitle(null, nextTrayEvent([overnight], at), at)).toBe('Now · Launch planning')
    expect(trayItems(null, overnight, [], at)[0].enabled).toBe(true)
  })

  it('uses regional date order and a 24-hour clock', () => {
    const at = new Date(2026, 10, 19, 17).getTime(), start = new Date(2026, 10, 20, 14, 30).getTime()
    const next = { ...event, start, end: start + 30 * min }
    expect(trayTitle(null, next, at, (ms, dated) => formatTrayTime(ms, dated, 'en-GB'))).toBe('Launch planning · 20 Nov 14:30')
    expect(formatTrayTime(start, false, 'en-US', false)).toBe('14:30')
    expect(formatTrayTime(start, false, 'en-GB', true)).toMatch(/2:30\s*pm/i)
  })

  it('keeps the countdown and whole characters when shortening a single-line title', () => {
    const cluster = '👩🏽‍💻'
    const title = (name: string) => trayTitle(null, { ...event, title: name }, now)
    expect(title(cluster.repeat(22))).toBe(cluster.repeat(22) + ' · in 1h')
    expect(title(cluster.repeat(23))).toBe(cluster.repeat(21) + '… · in 1h')
    expect(title('    ')).toBe('Meeting · in 1h')
    expect(title('Weekly\n sync')).toBe('Weekly sync · in 1h')
  })

  it('uses the interface language for the sentence and compact time units', () => {
    setLanguage('zh-TW')
    expect(trayTitle(null, { ...event, start: now + 45 * min }, now).replace(/\s/g, '')).toBe('Launchplanning·45分鐘後')
  })

  it('keeps the recording timer and localized pause label ahead of a live meeting on every platform', () => {
    setLanguage('fr')
    const live = { ...event, start: now }
    for (const paused of [false, true]) {
      expect(trayLook('darwin', { paused }, 754000, live, now).title).toBe(paused ? 'En pause' : '12:34')
      for (const os of ['win32', 'linux']) expect(trayLook(os, { paused }, 754000, live, now).tooltip).toBe(paused ? 'En pause' : '● 12:34')
    }
  })

  it('omits a declined invitation and stays empty without an eligible event', () => {
    const declined = { ...event, start: now, declined: true }
    expect(nextTrayEvent([declined, event], now)).toBe(event)
    expect(trayTitle(null, nextTrayEvent([declined], now), now)).toBe('')
    expect(trayTitle(null, nextTrayEvent([], now), now)).toBe('')
  })
})
