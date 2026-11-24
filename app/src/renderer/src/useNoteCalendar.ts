import { useCallback, useEffect, useState } from 'react'
import type { Meeting, YogurtApi } from '../../shared/types'

type CalendarList = Awaited<ReturnType<YogurtApi['calendar']['list']>>
export type NoteCalendar = { key: string; result: Awaited<ReturnType<YogurtApi['calendar']['day']>>; colors: Record<string, string> }
let calendars: Promise<CalendarList> | undefined
let watching = false

function calendarList() {
  if (!watching) {
    watching = true
    const invalidate = () => { calendars = undefined }
    window.yogurt.calendar.onChange(invalidate)
    window.addEventListener('focus', invalidate)
  }
  if (!calendars) {
    const read = window.yogurt.calendar.list()
    calendars = read
    void read.then(value => { if (value.status !== 'granted' && calendars === read) calendars = undefined }, () => { if (calendars === read) calendars = undefined })
  }
  return calendars
}

/** Read the linked event while the note is visible, before its date popover opens. */
export function useNoteCalendar(m: Meeting) {
  const [details, setDetails] = useState<NoteCalendar>()
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision(n => n + 1), [])
  const at = m.eventStartedAt ?? m.startedAt
  const key = `${m.id}/${m.eventId}/${at}`
  const enabled = window.yogurt.capabilities.calendar && !!m.eventId
  useEffect(() => {
    if (!enabled) return
    let active = true
    void Promise.all([
      window.yogurt.calendar.day(at, 'link-event').catch(() => ({ status: 'error' as const, events: [] })),
      calendarList().catch(() => null),
    ]).then(([result, list]) => {
      if (active) setDetails({ key, result, colors: Object.fromEntries((list?.calendars ?? []).filter(c => /^#[0-9a-f]{6}$/i.test(c.color ?? '')).map(c => [c.id, c.color!])) })
    })
    const off = window.yogurt.calendar.onChange(refresh)
    window.addEventListener('focus', refresh)
    return () => { active = false; off(); window.removeEventListener('focus', refresh) }
  }, [enabled, key, at, revision, refresh])
  return { details: enabled && details?.key === key ? details : undefined, refresh }
}
