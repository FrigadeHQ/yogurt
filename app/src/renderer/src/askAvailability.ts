import { createContext } from 'react'
import type { YogurtApi } from '../../shared/types'

export const AskRecordingWait = createContext<boolean | undefined>(undefined)

/** A recording can start or stop while the initial state is in flight. */
export function watchRecordingWait(api: Pick<YogurtApi['conversations'], 'onRecordingWait' | 'waitsForMeeting'>, update: (waiting: boolean) => void) {
  let acceptInitial = true
  const off = api.onRecordingWait(waiting => { acceptInitial = false; update(waiting) })
  void api.waitsForMeeting().then(waiting => { if (acceptInitial) update(waiting) }, () => {})
  return () => { acceptInitial = false; off() }
}
