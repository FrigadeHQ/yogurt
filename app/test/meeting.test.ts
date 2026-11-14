import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { Capture, activeCapture, hookCapture, recordingFinished, type CaptureProc } from '../src/main/capture'
import { openStore, type Store } from '../src/main/store'
import { activeMeeting, bindMeetingApp, getMeeting, initMeetings, onMeetingChange, onMeetingStart, onMeetingStop, onMeetingStopSaved, prepareMeeting, startPreparedMeeting, resumeMeeting, pauseMeetingClock, renameMeeting, retryStopSave, setAttendees, refreshEventSnapshots, linkEvent, unlinkEvent, startMeeting, stopMeeting, withStopState } from '../src/main/meeting'

let store: Store
beforeEach(() => { store = openStore(':memory:'); initMeetings(store) })

const event = { id: 'e1', title: 'Design review', start: 1000, end: 2000, attendees: [{ name: 'Ann', email: 'ann@x.com' }], url: null }

describe('meeting lifecycle', () => {
  it.each(['stopped', 'done'] as const)('returns the existing %s event note without starting capture before the guarded resume', state => {
    const original = startMeeting({ title: event.title, event, app: null })
    stopMeeting(original.id)
    store.updateMeeting(original.id, { state })
    store.setNotes(original.id, { mine: 'Keep these notes.', enhanced: 'Keep this summary.' })
    const starts = vi.fn(), off = onMeetingStart(starts)
    try {
      const same = startMeeting({ title: event.title, event: { ...event, id: 'calendar-copy', aliases: [event.id] }, app: null })
      expect(same).toMatchObject({ id: original.id, state })
      expect(store.meetings({ limit: 10 })).toHaveLength(1)
      expect(store.notes(original.id)).toMatchObject({ mine: 'Keep these notes.', enhanced: 'Keep this summary.' })
      expect(activeMeeting()).toBeNull()
      expect(starts).not.toHaveBeenCalled()
    } finally { off() }
  })
  it('uses the same newest non-trashed event note as the agenda, including ties', () => {
    const create = (startedAt: number) => store.createMeeting({ title: 'Review fixture', startedAt, endedAt: startedAt + 1, eventId: event.id, attendees: [], app: null, state: 'done' })
    create(100)
    const latest = create(200), tied = create(200)
    const start = () => startMeeting({ title: event.title, event, app: null })
    expect(start().id).toBe(tied.id)
    store.db.prepare('UPDATE meetings SET trashed_at = 300 WHERE id = ?').run(tied.id)
    expect(start().id).toBe(latest.id)
    expect(start().id).toBe(store.meetingForEvent(event.id)?.id)
  })
  it('starts fresh for an unlinked event and for each unattached recording', () => {
    const first = startMeeting({ title: 'First fixture', event: null, app: null })
    stopMeeting(first.id)
    const second = startMeeting({ title: 'Second fixture', event: null, app: null })
    expect(second.id).not.toBe(first.id)
    stopMeeting(second.id)
    expect(startMeeting({ title: event.title, event, app: null }).state).toBe('recording')
    expect(store.meetings({ limit: 10 })).toHaveLength(3)
  })
  it('persists a late call binding only for the current unbound recording', () => {
    const m = startMeeting({ title: 'Meeting', event: null, app: null })
    expect(bindMeetingApp('other', 'Zoom')).toBeUndefined()
    expect(bindMeetingApp(m.id, 'Zoom')?.app).toBe('Zoom')
    expect(activeMeeting()?.app).toBe('Zoom')
    expect(store.meeting(m.id)?.app).toBe('Zoom')
    expect(bindMeetingApp(m.id, 'Teams')).toBeUndefined()
    stopMeeting(m.id)
    expect(bindMeetingApp(m.id, 'Teams')).toBeUndefined()
  })
  it('reuses the prepared note when another calendar copy becomes the visible event', () => {
    const prepared = prepareMeeting(event)
    const otherCopy = { ...event, id: 'other-copy', aliases: [event.id] }
    expect(prepareMeeting(otherCopy).id).toBe(prepared.id)
    expect(startMeeting({ title: event.title, event: otherCopy, app: null }).id).toBe(prepared.id)
  })
  it('resuming preserves the original date and notes while duration excludes the gap and pauses', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const starts = vi.fn(), off = onMeetingStart(starts)
    try {
      const m = startMeeting({ title: 'Keep our title', event: null, app: null })
      store.setNotes(m.id, { mine: 'Manual notes stay.', enhanced: 'Prior summary.' })
      store.addSegments([{ meetingId: m.id, track: 'them', startMs: 0, endMs: 4000, text: 'Prior words.', speaker: 'Ann' }])
      clock.mockReturnValue(110_000); stopMeeting(m.id)
      clock.mockReturnValue(10_000_000)
      const resumed = resumeMeeting(m.id, { part: 1, startMs: 10_000 })!
      expect(resumed).toMatchObject({ id: m.id, startedAt: 100_000, endedAt: null, state: 'recording' })
      expect(store.notes(m.id)).toMatchObject({ mine: 'Manual notes stay.', enhanced: 'Prior summary.' })
      expect(store.segments(m.id)[0]).toMatchObject({ text: 'Prior words.', speaker: 'Ann' })
      expect(starts.mock.calls[1][0]).toMatchObject({ resume: { part: 1, startMs: 10_000, startedAt: 10_000_000, capturedMs: 10_000 } })
      clock.mockReturnValue(10_005_000); pauseMeetingClock(m.id, true)
      clock.mockReturnValue(10_105_000); pauseMeetingClock(m.id, false)
      clock.mockReturnValue(10_110_000); stopMeeting(m.id)
      expect(store.meeting(m.id)).toMatchObject({ startedAt: 100_000, endedAt: 10_110_000, durationMs: 20_000, state: 'stopped' })
      expect(resumeMeeting(m.id, { part: 0, startMs: 0 })).toBeUndefined()
    } finally { off(); clock.mockRestore() }
  })

  it('a failed Resume state save never starts capture or changes the finished note, and can retry', () => {
    const m = startMeeting({ title: 'Retained note', event: null, app: null })
    stopMeeting(m.id)
    const prior = store.meeting(m.id), started = vi.fn(), off = onMeetingStart(started)
    const write = vi.spyOn(store, 'updateMeeting').mockImplementation(() => { throw new Error('disk unavailable') })
    try {
      expect(() => resumeMeeting(m.id, { part: 1, startMs: 4000 })).toThrow('disk unavailable')
      expect(activeMeeting()).toBeNull()
      expect(started).not.toHaveBeenCalled()
      expect(store.meeting(m.id)).toEqual(prior)
      write.mockRestore()
      expect(resumeMeeting(m.id, { part: 1, startMs: 4000 })?.state).toBe('recording')
      expect(started).toHaveBeenCalledTimes(1)
    } finally { write.mockRestore(); off() }
  })

  it('preparing a calendar note saves its date and people without capture, enhancement, or interrupted-recording recovery', () => {
    const started = vi.fn(), stopped = vi.fn()
    const off = [onMeetingStart(started), onMeetingStopSaved(stopped)]
    try {
      const m = prepareMeeting(event)
      expect(m).toMatchObject({ title: event.title, eventId: event.id, startedAt: event.start, state: 'prepared', attendees: event.attendees, endedAt: null })
      expect(activeMeeting()).toBeNull()
      expect(started).not.toHaveBeenCalled()
      expect(stopMeeting(m.id)?.state).toBe('prepared')
      expect(stopped).not.toHaveBeenCalled()
      expect(store.markInterrupted()).toBe(0)
      expect(store.unenhancedMeetings()).toEqual([])
    } finally { off.forEach((f) => f()) }
  })
  it('repeated Prepare opens the existing note without replacing typed notes or manual meeting details', () => {
    const m = prepareMeeting(event)
    renameMeeting(m.id, 'Our launch agenda')
    setAttendees(m.id, [{ name: 'Bo', email: null }])
    store.setNotes(m.id, { mine: 'Discuss launch dates and blockers.' })
    expect(prepareMeeting({ ...event, title: 'Changed calendar title' })).toMatchObject({ id: m.id, title: 'Our launch agenda', attendees: [{ name: 'Bo', email: null }] })
    expect(store.meetings({ limit: 10 })).toHaveLength(1)
    expect(store.notes(m.id).mine).toBe('Discuss launch dates and blockers.')
    startPreparedMeeting(m.id)
    stopMeeting(m.id)
    expect(prepareMeeting(event).id).toBe(m.id)
  })
  it('recording a prepared note reuses its id and typed notes; a second click cannot restart a finished capture', () => {
    const m = prepareMeeting(event)
    store.setNotes(m.id, { mine: 'Keep this agenda.' })
    renameMeeting(m.id, 'Launch planning')
    const started = vi.fn(), off = onMeetingStart(started)
    try {
      const live = startPreparedMeeting(m.id)!
      expect(live).toMatchObject({ id: m.id, title: 'Launch planning', state: 'recording', eventId: event.id, endedAt: null })
      expect(live.startedAt).toBeGreaterThan(event.start)
      expect(store.notes(m.id).mine).toBe('Keep this agenda.')
      expect(startPreparedMeeting(m.id)?.id).toBe(m.id)
      expect(started).toHaveBeenCalledTimes(1)
      stopMeeting(m.id)
      expect(startPreparedMeeting(m.id)).toBeUndefined()
      expect(startPreparedMeeting('missing')).toBeUndefined()
    } finally { off() }
  })
  it('a calendar Take notes reuses a prepared note and an active meeting takes precedence without touching another prepared note', () => {
    const prepared = prepareMeeting(event)
    const live = startMeeting({ title: event.title, event, app: 'Zoom' })
    expect(live).toMatchObject({ id: prepared.id, app: 'Zoom', state: 'recording' })
    const other = prepareMeeting({ ...event, id: 'next-occurrence', start: 3000 })
    expect(startPreparedMeeting(other.id)?.id).toBe(live.id)
    expect(store.meeting(other.id)?.state).toBe('prepared')
    expect(store.meetings({ limit: 10 })).toHaveLength(2)
  })
  it('a prepared start needs no second database read after its recording state is saved', () => {
    const m = prepareMeeting(event)
    const read = store.meeting.bind(store)
    const failedRead = vi.spyOn(store, 'meeting').mockImplementation((id) => {
      const row = read(id)
      if (row?.state === 'recording') throw new Error('read failed after successful save')
      return row
    })
    const started = vi.fn(), off = onMeetingStart(started)
    try {
      expect(startPreparedMeeting(m.id)).toMatchObject({ id: m.id, state: 'recording' })
      expect(activeMeeting()?.id).toBe(m.id)
      expect(started).toHaveBeenCalledTimes(1)
    } finally { failedRead.mockRestore(); off() }
  })
  it('unlinking a calendar event preserves manual title, attendees, notes and the active capture', () => {
    const m = startMeeting({ title: event.title, event, app: 'Zoom' })
    renameMeeting(m.id, 'My edited title')
    setAttendees(m.id, [{ name: 'Bo', email: 'bo@example.com' }])
    store.setNotes(m.id, { mine: 'Keep these notes.' })
    const { eventStartedAt, eventEndedAt, eventTitle, eventCalendarName, eventCalendarSource, ...before } = getMeeting(m.id)!
    expect(unlinkEvent(m.id)).toEqual({ ...before, eventId: null })
    expect(activeMeeting()).toEqual({ ...before, eventId: null })
    expect(store.notes(m.id).mine).toBe('Keep these notes.')
    expect(unlinkEvent(m.id)).toEqual({ ...before, eventId: null })
    expect(unlinkEvent('missing')).toBeUndefined()
  })
  it('startMeeting stores a recording meeting with the event\'s people', () => {
    const m = startMeeting({ title: 'Design review', event, app: 'Zoom' })
    expect(m).toMatchObject({ title: 'Design review', state: 'recording', eventId: 'e1', app: 'Zoom', attendees: event.attendees, endedAt: null })
    expect(store.meeting(m.id)).toEqual(m)
    expect(activeMeeting()?.id).toBe(m.id)
  })
  it('without an event it keeps the title and the app', () => {
    const m = startMeeting({ title: 'Zoom call', event: null, app: 'Zoom' })
    expect(m).toMatchObject({ eventId: null, attendees: [] })
  })
  it('stopMeeting sets stopped and the end time, and clears the active one', () => {
    const m = startMeeting({ title: 'x', event: null, app: null })
    const done = stopMeeting(m.id)!
    expect(done.state).toBe('stopped')
    expect(done.endedAt).toBeGreaterThan(0)
    expect(store.meeting(m.id)?.state).toBe('stopped')
    expect(activeMeeting()).toBeNull()
  })
  it('stops capture when saving fails, keeps the exact end time for retry, and finalizes only once', async () => {
    const off: Array<() => void> = []
    const stopped = vi.fn(), saved = vi.fn(), commands: string[] = []
    const process = new EventEmitter()
    const input = new PassThrough(), output = new PassThrough()
    input.on('data', (chunk) => {
      commands.push(chunk.toString())
      if (chunk.toString() === 'stop\n') queueMicrotask(() => process.emit('exit', 0, null))
    })
    const proc: CaptureProc = { stdin: input, stdout: output, on: process.on.bind(process), kill: () => true }
    off.push(onMeetingStop(() => { throw new Error('another stop hook failed') }))
    hookCapture({ dirOf: () => '/unused-fake-capture',
      onStart: (fn) => off.push(onMeetingStart(fn)), onStop: (fn) => off.push(onMeetingStop(fn)),
      start: () => new Capture(proc), stopMeeting,
    })
    off.push(onMeetingStop(stopped), onMeetingStopSaved(saved))
    const m = startMeeting({ title: 'Save trouble', event: null, app: null })
    const update = vi.spyOn(store, 'updateMeeting').mockImplementation(() => { throw new Error('SQLITE_FULL') })
    try {
      const result = stopMeeting(m.id)!
      expect(commands).toEqual(['stop\n'])
      expect(activeCapture()).toBeNull()
      expect(activeMeeting()).toBeNull()
      expect(result).toMatchObject({ state: 'stopped', stopSavePending: true })
      expect(getMeeting(m.id)).toMatchObject({ state: 'stopped', endedAt: result.endedAt, stopSavePending: true })
      expect(store.meeting(m.id)).toMatchObject({ state: 'recording', endedAt: null })
      expect(withStopState(store.meeting(m.id)!)).toMatchObject({ state: 'stopped', endedAt: result.endedAt })
      expect(stopped).toHaveBeenCalledTimes(1)
      expect(saved).not.toHaveBeenCalled()
      expect(retryStopSave(m.id)).toBe(false)
      stopMeeting(m.id)
      expect(stopped).toHaveBeenCalledTimes(1)
      update.mockRestore()
      expect(retryStopSave(m.id)).toBe(true)
      expect(store.meeting(m.id)).toMatchObject({ state: 'stopped', endedAt: result.endedAt })
      expect(getMeeting(m.id)?.stopSavePending).toBeUndefined()
      expect(saved).toHaveBeenCalledTimes(1)
      expect(retryStopSave(m.id)).toBe(true)
      stopMeeting(m.id)
      expect(stopped).toHaveBeenCalledTimes(1)
      expect(saved).toHaveBeenCalledTimes(1)
      expect(commands).toEqual(['stop\n'])
      await recordingFinished(m.id)
    } finally { update.mockRestore(); off.forEach((f) => f()) }
  })
  it('uses the active meeting to stop even when the database cannot be read', () => {
    const m = startMeeting({ title: 'Read trouble', event: null, app: null })
    const stopped = vi.fn(), off = onMeetingStop(stopped)
    const read = vi.spyOn(store, 'meeting').mockImplementation(() => { throw new Error('SQLITE_IOERR') })
    try {
      expect(stopMeeting(m.id)).toMatchObject({ id: m.id, state: 'stopped' })
      expect(activeMeeting()).toBeNull()
      expect(stopped).toHaveBeenCalledTimes(1)
    } finally { read.mockRestore(); off() }
  })
  it('keeps rename and successive people edits while Stop is pending, including the retry event', () => {
    const m = startMeeting({ title: 'Original', event: null, app: null })
    const update = store.updateMeeting.bind(store)
    const failStop = vi.spyOn(store, 'updateMeeting').mockImplementation((id, patch) => {
      if (patch.endedAt !== undefined) throw new Error('stop metadata only failed')
      update(id, patch)
    })
    const changed = vi.fn(), off = onMeetingChange(changed)
    try {
      const stopped = stopMeeting(m.id)!
      renameMeeting(m.id, 'Renamed after Stop')
      setAttendees(m.id, [{ name: 'Ann', email: null }])
      const first = getMeeting(m.id)!
      expect(first.title).toBe('Renamed after Stop')
      setAttendees(m.id, [...first.attendees, { name: 'Bo', email: null }])
      expect(getMeeting(m.id)?.attendees.map((p) => p.name)).toEqual(['Ann', 'Bo'])
      expect(retryStopSave(m.id)).toBe(false)
      expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Renamed after Stop', endedAt: stopped.endedAt }))
      failStop.mockRestore()
      expect(retryStopSave(m.id)).toBe(true)
      expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Renamed after Stop', attendees: first.attendees.concat({ name: 'Bo', email: null }), endedAt: stopped.endedAt }))
    } finally { failStop.mockRestore(); off() }
  })
  it('a second start while recording returns the one already running', () => {
    const a = startMeeting({ title: 'a', event: null, app: null })
    expect(startMeeting({ title: 'b', event: null, app: null }).id).toBe(a.id)
  })
  it('runs the hooks later steps plug into, and a failing hook does not stop the meeting', () => {
    const start = vi.fn(), stop = vi.fn()
    onMeetingStart(() => { throw new Error('bad hook') })
    onMeetingStart(start); onMeetingStop(stop)
    const m = startMeeting({ title: 'x', event: null, app: null })
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: m.id }))
    stopMeeting(m.id)
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({ id: m.id, state: 'stopped' }))
  })
  it('setAttendees: names tidied, blanks dropped, saved, and the windows hear of it', () => {
    const m = startMeeting({ title: 'x', event: null, app: null })
    const heard = vi.fn()
    onMeetingChange(heard)
    const after = setAttendees(m.id, [{ name: '  Ann   Lee ', email: ' ann@x.com ' }, { name: '  ', email: null }, { name: 'Bo', email: '' }])
    expect(after?.attendees).toEqual([{ name: 'Ann Lee', email: 'ann@x.com' }, { name: 'Bo', email: null }])
    expect(store.meeting(m.id)?.attendees).toEqual(after?.attendees)
    expect(activeMeeting()?.attendees).toEqual(after?.attendees)
    expect(heard).toHaveBeenCalled()
  })
  it('linkEvent: the event\'s id, title and people', () => {
    const m = startMeeting({ title: 'Zoom call', event: null, app: null })
    const after = linkEvent(m.id, event)
    expect(after).toMatchObject({ eventId: 'e1', eventStartedAt: event.start, title: 'Design review', titleSource: 'calendar', attendees: event.attendees, startedAt: m.startedAt })
    expect(store.meeting(m.id)).toMatchObject({ eventId: 'e1', eventStartedAt: event.start, title: 'Design review' })
    expect(unlinkEvent(m.id)?.eventStartedAt).toBeUndefined()
  })
  it('relinking an empty prepared note uses the new event end for cleanup', () => {
    const day = 86_400_000, now = Date.now()
    const m = prepareMeeting({ ...event, start: now - 3 * day, end: now - 3 * day + 1000 })
    linkEvent(m.id, { ...event, id: 'next-week', start: now + 7 * day, end: now + 7 * day + 1000 })
    expect(store.tidyPrepared(now + 2 * day, () => false)).toBe(0)
    expect(store.meeting(m.id)).toBeDefined()
    expect(store.tidyPrepared(now + 9 * day, () => false)).toBe(1)
  })
  it('renameMeeting: tidied and saved, the running meeting too, and the windows hear of it; a blank title is ignored', () => {
    const changed = vi.fn()
    onMeetingChange(changed)
    const m = startMeeting({ title: 'Zoom call', event: null, app: 'Zoom' })
    changed.mockClear()
    expect(renameMeeting(m.id, '  Budget\n  review ')?.title).toBe('Budget review')
    expect(store.meeting(m.id)!.title).toBe('Budget review')
    expect(activeMeeting()!.title).toBe('Budget review')
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ id: m.id, title: 'Budget review' }))
    expect(renameMeeting(m.id, '   ')).toBeUndefined()
    expect(renameMeeting(m.id, 'x'.repeat(500))!.title).toHaveLength(200)
    expect(renameMeeting('nope', 'Hello')).toBeUndefined()
  })
})

it('captures event details on prepare, recording and relink, and clears them on unlink', () => {
  const scheduled = { ...event, calendar: { id: 'work', name: 'Work', source: 'Calendar' } }
  const snapshot = { eventStartedAt: event.start, eventEndedAt: event.end, eventTitle: event.title, eventCalendarName: 'Work', eventCalendarSource: 'Calendar' }
  const prepared = prepareMeeting(scheduled)
  expect(store.meeting(prepared.id)).toMatchObject(snapshot)
  const recording = startMeeting({ title: 'A note', event: { ...scheduled, id: 'other' }, app: null })
  expect(store.meeting(recording.id)).toMatchObject(snapshot)
  linkEvent(recording.id, { ...event, title: 'New event', end: 4000 })
  expect(store.meeting(recording.id)).toMatchObject({ eventEndedAt: 4000, eventTitle: 'New event' })
  expect(store.meeting(recording.id)?.eventCalendarName).toBeUndefined()
  expect(store.meeting(recording.id)?.eventCalendarSource).toBeUndefined()
  unlinkEvent(recording.id)
  for (const key of Object.keys(snapshot)) expect(store.meeting(recording.id)).not.toHaveProperty(key)
})
it('calendar reads refresh active snapshots without changing manual edits or notifying on identical reads', () => {
  const m = startMeeting({ title: 'My title', event, app: null })
  setAttendees(m.id, [{ name: 'My person', email: null }])
  store.setNotes(m.id, { mine: 'Keep my notes' })
  const heard = vi.fn(), off = onMeetingChange(heard)
  try {
    const changed = { ...event, title: 'Renamed event', start: 1500, end: 5000, calendar: { id: 'work', name: 'Work', source: 'Calendar' } }
    refreshEventSnapshots([changed])
    expect(activeMeeting()).toMatchObject({ title: 'My title', eventTitle: 'Renamed event', eventStartedAt: 1500, eventEndedAt: 5000, eventCalendarName: 'Work', attendees: [{ name: 'My person', email: null }] })
    expect(store.notes(m.id).mine).toBe('Keep my notes')
    expect(heard).toHaveBeenCalledTimes(1)
    refreshEventSnapshots([changed])
    expect(heard).toHaveBeenCalledTimes(1)
    refreshEventSnapshots([])
    expect(store.meeting(m.id)?.eventEndedAt).toBe(5000)
    const fail = vi.spyOn(store, 'rememberEvent').mockImplementation(() => { throw new Error('disk full') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try { expect(() => refreshEventSnapshots([event])).not.toThrow(); expect(warn).toHaveBeenCalled() }
    finally { fail.mockRestore(); warn.mockRestore() }
  } finally { off() }
})
