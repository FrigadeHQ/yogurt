import { useEffect, useState } from 'react'
export { dayLabel, daysAgo, noteDateLabel, timeOf } from '../../shared/dates'

/** Today's date, which changes just after midnight (and when the Mac wakes on another day), so day names stay true */
export function useDay(): string {
  const [day, setDay] = useState(() => new Date().toDateString())
  useEffect(() => {
    const next = new Date(); next.setHours(24, 0, 1, 0)
    const timer = setTimeout(() => setDay(new Date().toDateString()), next.getTime() - Date.now())
    const check = () => setDay(new Date().toDateString())
    window.addEventListener('focus', check)
    return () => { clearTimeout(timer); window.removeEventListener('focus', check) }
  }, [day])
  return day
}

/** Refresh at the next boundary, including after the window wakes. */
export function useBoundaryTime(end: number | null | undefined, start?: number): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const update = () => {
      clearTimeout(timer)
      const at = Date.now()
      setNow(at)
      const next = start != null && at < start ? start : end != null && at < end ? end : undefined
      if (next !== undefined) timer = setTimeout(update, Math.min(next - at, 2_147_483_647))
    }
    update()
    window.addEventListener('focus', update)
    return () => { clearTimeout(timer); window.removeEventListener('focus', update) }
  }, [start, end])
  return now
}
