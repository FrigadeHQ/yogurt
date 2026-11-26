import { canJoinEvent, JOIN_EARLY_MS } from '../../shared/comingUp'
import { useBoundaryTime } from './dates'

export function useJoinWindow(start: number, end: number | null | undefined): boolean {
  return canJoinEvent(start, end, useBoundaryTime(end, start - JOIN_EARLY_MS))
}
