import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ meeting: null as null | { id: string; title: string }, paused: false, change: () => {}, recording: (_e: { t: string }) => {}, language: () => {}, trays: [] as any[] }))
vi.mock('electron', () => ({
  app: { quit: vi.fn(), on: vi.fn(), getSystemLocale: vi.fn(() => 'en-US') },
  systemPreferences: { getUserDefault: vi.fn(() => false) },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
  Menu: { buildFromTemplate: (items: unknown) => items },
  nativeImage: { createFromPath: (path: string) => ({ path, setTemplateImage: vi.fn() }) },
  Tray: class {
    on = vi.fn()
    destroy = vi.fn()
    setContextMenu = vi.fn()
    setTitle = vi.fn()
    setToolTip = vi.fn()
    setImage = vi.fn()
    image: any
    constructor(image: any) { this.image = image; state.trays.push(this) }
  },
}))
vi.mock('../src/main/meeting', () => ({ activeMeeting: () => state.meeting, onMeetingChange: (fn: () => void) => { state.change = fn } }))
vi.mock('../src/main/capture', () => ({ recordingPaused: () => state.paused, onRecordingEvent: (fn: typeof state.recording) => { state.recording = fn } }))
vi.mock('../src/shared/i18n', async original => ({ ...await original<typeof import('../src/shared/i18n')>(), onLanguage: (fn: () => void) => { state.language = fn } }))
import { app, powerMonitor, systemPreferences } from 'electron'
const basename = (p: string) => p.split(/[\\/]/).at(-1)
import { createTray } from '../src/main/tray'

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
beforeEach(() => { vi.useFakeTimers(); state.trays = []; state.meeting = null; state.paused = false })
const actions = () => ({ open: vi.fn(), newNote: vi.fn(), stop: vi.fn(), pause: vi.fn(), ask: vi.fn(), settings: vi.fn(), openNote: vi.fn(), events: vi.fn(async () => [] as import('../src/main/calendar').CalEvent[]), event: vi.fn(async () => {}), recent: () => [], elapsed: () => 723000 })

it('creates by default, destroys immediately, and recreates with the current recording state', () => {
  const tray = createTray({ show: true, ...actions() })
  expect(state.trays).toHaveLength(1)
  tray.setVisible(false)
  tray.setVisible(false)
  expect(state.trays[0].destroy).toHaveBeenCalledTimes(1)
  state.meeting = { id: 'm1', title: 'Standup' }
  state.change(); state.language(); state.recording({ t: 'paused' })
  expect(state.trays).toHaveLength(1)
  tray.setVisible(true)
  tray.setVisible(true)
  expect(state.trays).toHaveLength(2)
  expect(state.trays[1].setTitle).toHaveBeenLastCalledWith('12:03', { fontType: 'monospacedDigit' })
  expect(state.trays[1].setContextMenu).toHaveBeenCalled()
})

it('starts hidden and keeps menu hooks working during recording and pause', () => {
  const d = actions()
  const tray = createTray({ show: true, visible: false, ...d })
  expect(state.trays).toHaveLength(0)
  tray.click('open'); tray.click('new')
  expect(d.open).toHaveBeenCalledOnce(); expect(d.newNote).toHaveBeenCalledOnce()
  state.meeting = { id: 'm1', title: 'Standup' }; state.change()
  expect(tray.items()).toContain('Stop recording')
  tray.click('stop'); expect(d.stop).toHaveBeenCalledWith('m1')
  state.paused = true; state.recording({ t: 'paused' })
  expect(state.trays).toHaveLength(0)
  tray.setVisible(true)
  expect(state.trays[0].setTitle).toHaveBeenLastCalledWith('Paused', { fontType: 'monospacedDigit' })
  expect(state.trays[0].setToolTip).toHaveBeenLastCalledWith('Recording paused')
})

it('never creates a native icon in background tests, even when toggled on', () => {
  const d = actions()
  const tray = createTray({ show: false, ...d })
  tray.setVisible(false); tray.setVisible(true)
  expect(state.trays).toHaveLength(0)
  expect(tray.items()).toContain('Open Yogurt')
  tray.click('open'); expect(d.open).toHaveBeenCalledOnce()
})

it('updates the title each second and dispatches existing actions, including while hidden', async () => {
  const d = actions(), started = Date.now(), tray = createTray({ show: true, ...d, elapsed: () => Date.now() - started })
  state.meeting = { id: 'm1', title: 'Standup' }; state.change()
  state.trays[0].setTitle.mockClear()
  vi.advanceTimersByTime(3000)
  expect(state.trays[0].setTitle).toHaveBeenCalledTimes(3)
  expect(state.trays[0].setTitle).toHaveBeenLastCalledWith('0:03', { fontType: 'monospacedDigit' })
  tray.click('pause'); expect(d.pause).toHaveBeenLastCalledWith('m1', true)
  state.paused = true
  tray.click('pause'); expect(d.pause).toHaveBeenLastCalledWith('m1', false)
  tray.setVisible(false)
  tray.click('ask'); tray.click('settings'); tray.click('note:m1')
  expect(d.ask).toHaveBeenCalledOnce(); expect(d.settings).toHaveBeenCalledOnce(); expect(d.openNote).toHaveBeenCalledWith('m1')
  vi.advanceTimersByTime(3000)
  expect(state.trays).toHaveLength(1)
})

it('refreshes calendar targets without letting an older read overwrite a newer one', async () => {
  const d = actions()
  const now = Date.now(), event = { id: 'event', title: 'Next call', start: now, end: now + 3600000, url: 'https://example.com', attendees: [] }
  const tray = createTray({ show: false, ...d })
  let finish!: (events: typeof event[]) => void
  d.events.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const old = tray.refreshCalendar()
  d.events.mockResolvedValue([event]); await tray.refreshCalendar()
  finish([]); await old
  expect(tray.items()[0]).toBe('Now · Next call')
  tray.click('next')
  expect(d.event).not.toHaveBeenCalled()
  tray.click('join')
  await vi.waitFor(() => expect(d.event).toHaveBeenCalledWith(event, true))
  state.meeting = { id: 'm1', title: 'Standup' }; state.change()
  tray.click('join'); expect(d.event).toHaveBeenCalledOnce()
})

it('records the event named in the menu and ignores a stale click after it disappears', async () => {
  const d = actions(), at = Date.now()
  const event = { id: 'review', title: 'Review', start: at, end: at + 3_600_000, url: null, attendees: [{ name: 'Guest', email: null }] }
  d.events.mockResolvedValue([event])
  const tray = createTray({ show: true, ...d })
  await tray.refreshCalendar()
  const menu = state.trays[0].setContextMenu.mock.lastCall[0] as { label?: string; click(): void }[]
  const record = menu.find(item => item.label === 'Record Review')!
  record.click()
  await vi.waitFor(() => expect(d.event).toHaveBeenCalledWith(event, false))
  expect(d.newNote).not.toHaveBeenCalled()

  d.events.mockResolvedValue([{ ...event, id: 'planning', title: 'Planning' }])
  await tray.refreshCalendar()
  record.click()
  await Promise.resolve()
  expect(d.event).toHaveBeenCalledTimes(1)
})

it('Windows and Linux: a colour icon that turns to the recording one, the time in the tooltip, and a click opens Yogurt', () => {
  const d = actions()
  const tray = createTray({ show: true, os: 'win32', ...d })
  const icon = state.trays[0]
  expect(basename(icon.image.path)).toBe('tray-color.png')
  expect(icon.image.setTemplateImage).not.toHaveBeenCalled()
  ;(icon.on.mock.calls.find((c: any[]) => c[0] === 'click')![1] as () => void)()
  expect(d.open).toHaveBeenCalledOnce()
  state.meeting = { id: 'm1', title: 'Standup' }; state.change()
  expect(basename(icon.setImage.mock.lastCall[0].path)).toBe('tray-recording.png')
  expect(icon.setTitle).not.toHaveBeenCalled()
  expect(icon.setToolTip).toHaveBeenLastCalledWith('● 12:03')
  vi.advanceTimersByTime(1000)
  expect(icon.setToolTip).toHaveBeenLastCalledWith('● 12:03')
  state.paused = true; state.recording({ t: 'paused' })
  expect(basename(icon.setImage.mock.lastCall[0].path)).toBe('tray-color.png')
  expect(tray.accelerators()).toEqual({ 'Settings…': 'Ctrl+,' })
})

it('Linux without a tray host (GNOME without its extension) says no icon is shown, so closing minimises', async () => {
  const tray = createTray({ show: true, os: 'linux', host: async () => false, ...actions() })
  expect(tray.shown()).toBe(true)
  await vi.waitFor(() => expect(tray.shown()).toBe(false))
  tray.setVisible(false)
  const mac = createTray({ show: true, ...actions() })
  expect(mac.shown()).toBe(true)
  mac.setVisible(false)
  expect(mac.shown()).toBe(false)
})

it('ticks on the wall minute, keeps the same native title between changes, and catches up on wake', async () => {
  const midnight = new Date(2026, 10, 10).getTime()
  vi.setSystemTime(midnight - 30_000)
  const d = actions()
  const event = { id: 'review', title: 'Weekly sync', start: midnight + 60_000, end: midnight + 120_000, attendees: [], url: 'https://example.com' }
  d.events.mockResolvedValue([event])
  const tray = createTray({ show: true, ...d })
  await tray.refreshCalendar()
  const writes = state.trays[0].setTitle
  const title = () => writes.mock.lastCall[0]
  expect(title()).toBe('Weekly sync · Nov 10 12:01 AM')
  tray.click('next'); tray.click('join')
  expect(d.event).not.toHaveBeenCalled()
  writes.mockClear()
  await vi.advanceTimersByTimeAsync(29_999)
  expect(writes).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(title()).toBe('Weekly sync · in 1m')
  await tray.refreshCalendar()
  expect(writes).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(title()).toBe('Now · Weekly sync')
  vi.setSystemTime(midnight + 3_600_000)
  const [name, resume] = vi.mocked(powerMonitor.on).mock.lastCall!
  expect(name).toBe('resume')
  resume()
  expect(title()).toBe('')
})

it.each(['darwin', 'linux', 'win32'])('%s applies the switch immediately and retains it across hiding or recreating the tray', async os => {
  const at = new Date(2026, 10, 9, 10).getTime()
  vi.setSystemTime(at)
  const d = actions()
  d.events.mockResolvedValue([{ id: 'sync', title: 'Weekly sync', start: at + 1_800_000, end: at + 3_600_000, attendees: [], url: 'https://example.com' }])
  const tray = createTray({ show: true, visible: false, showNextMeeting: false, os, ...d })
  await tray.refreshCalendar()
  expect(state.trays).toHaveLength(0)
  const text = () => state.trays.at(-1)[os === 'darwin' ? 'setTitle' : 'setToolTip'].mock.lastCall[0]
  tray.setVisible(true)
  const idle = text()
  expect(idle).not.toContain('Weekly sync')
  tray.setShowNextMeeting(true)
  expect(text()).toBe('Weekly sync · in 30m')
  tray.setShowNextMeeting(false)
  expect(text()).toBe(idle)
  expect(tray.items().join(' ')).not.toContain('Weekly sync')
  tray.click('next'); tray.click('join')
  expect(d.event).not.toHaveBeenCalled()
  tray.setVisible(false)
  tray.setVisible(true)
  expect(text()).toBe(idle)
  tray.setShowNextMeeting(true)
  state.meeting = { id: 'recording', title: 'Notes' }; state.change()
  expect(text()).toBe(os === 'darwin' ? '12:03' : '● 12:03')
  tray.setShowNextMeeting(false)
  state.paused = true; state.recording({ t: 'paused' })
  const writes = state.trays.at(-1)[os === 'darwin' ? 'setTitle' : 'setToolTip']
  expect(text()).toBe('Paused')
  writes.mockClear()
  await vi.advanceTimersByTimeAsync(3000)
  expect(writes).not.toHaveBeenCalled()
  state.paused = false; state.recording({ t: 'paused' })
  expect(text()).toBe(os === 'darwin' ? '12:03' : '● 12:03')
  state.meeting = null; state.change()
  expect(text()).toBe(idle)
  tray.setShowNextMeeting(true)
  expect(text()).toBe('Weekly sync · in 30m')
  d.events.mockResolvedValue([]); await tray.refreshCalendar()
  expect(text()).toBe(idle)
})

it('switches at an off-minute start and goes straight to the next dated meeting at the end', async () => {
  const at = new Date(2026, 10, 9, 9).getTime()
  vi.setSystemTime(at)
  const d = actions()
  const review = { id: 'event', title: 'Review', start: at + 20_000, end: at + 50_000, attendees: [], url: 'https://example.com' }
  const tomorrow = new Date(2026, 10, 10, 11).getTime()
  d.events.mockResolvedValue([review, { ...review, id: 'event2', title: 'Sync', start: tomorrow, end: tomorrow + 60_000 }])
  const tray = createTray({ show: true, ...d })
  await tray.refreshCalendar()
  const text = () => state.trays[0].setTitle.mock.lastCall[0]
  expect(text()).toBe('Review · in 1m')
  d.events.mockClear()
  await vi.advanceTimersByTimeAsync(20_000)
  expect(text()).toBe('Now · Review')
  await vi.advanceTimersByTimeAsync(30_000)
  expect(text()).toBe('Sync · Nov 10 11:00 AM')
  expect(d.events).not.toHaveBeenCalled()
})

it('uses the clock until precisely one hour before an off-minute start', async () => {
  const at = new Date(2026, 10, 9, 9).getTime(), start = at + 3_615_000
  vi.setSystemTime(at)
  const d = actions()
  d.events.mockResolvedValue([{ id: 'review', title: 'Review', start, end: start + 60_000, attendees: [], url: 'https://example.com' }])
  const tray = createTray({ show: true, ...d })
  await tray.refreshCalendar()
  const text = () => state.trays[0].setTitle.mock.lastCall[0]
  expect(text()).toBe('Review · 10:00 AM')
  await vi.advanceTimersByTimeAsync(15_000)
  expect(text()).toBe('Review · in 1h')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(text()).toBe('Review · in 59m')
})

it('uses the system region for a dated event and honors the Mac clock override', async () => {
  const at = new Date(2026, 10, 19, 17).getTime(), start = new Date(2026, 10, 20, 14, 30).getTime()
  vi.setSystemTime(at)
  const d = actions()
  d.events.mockResolvedValue([{ id: 'call', title: 'Sync', start, end: start + 60_000, attendees: [], url: 'https://example.com' }])
  const region = vi.mocked(app.getSystemLocale)
  region.mockReturnValue('en-GB')
  try {
    const tray = createTray({ show: true, ...d })
    await tray.refreshCalendar()
    const text = () => state.trays[0].setTitle.mock.lastCall[0]
    expect(text()).toBe('Sync · 20 Nov 14:30')
    if (process.platform === 'darwin') {
      vi.mocked(systemPreferences.getUserDefault).mockImplementation(key => key === 'AppleICUForce24HourTime')
      region.mockReturnValue('en-US')
      await tray.refreshCalendar()
      expect(text()).toBe('Sync · Nov 20 14:30')
    }
  } finally {
    region.mockReturnValue('en-US')
    vi.mocked(systemPreferences.getUserDefault).mockReset()
  }
})
