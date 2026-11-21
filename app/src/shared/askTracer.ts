export const TRACER_LAP_MS = 750
// The ⌘J panel finishes opening in 180ms; the flare starts a short beat after it settles.
export const TRACER_DELAY_MS = 300
export const TRACER_CADENCE_MS = 8000

export type TracerState = { focused: boolean; hovered: boolean; hasText: boolean; reduced: boolean; hidden: boolean }

/** One scheduler per panel opening; only the opening lap may ignore autofocus. */
export function createTracerSchedule(initial: TracerState, play: () => number, stop: () => void) {
  let state = initial, opening = true, running = false, disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  // The opening lap plays the same however the panel opened: a pointer on the box (as after clicking Ask) only skips idle laps.
  const allowed = () => !state.hasText && !state.reduced && !state.hidden && (opening || !state.focused && !state.hovered)
  const cancel = () => { clearTimeout(timer); timer = undefined; running = false; stop() }
  const schedule = (delay: number) => {
    timer = setTimeout(() => {
      running = true
      const duration = play()
      timer = setTimeout(() => {
        stop(); timer = undefined; running = false; opening = false
        if (allowed()) schedule(TRACER_CADENCE_MS - duration)
      }, duration)
    }, delay)
  }
  const update = (next: TracerState) => {
    if (disposed) return
    state = next
    // Input only gates the next lap; let the current one finish at its original deadline.
    if (running && !state.reduced && !state.hidden) return
    if (!allowed()) { opening = false; cancel() }
    else if (timer === undefined) schedule(opening ? TRACER_DELAY_MS : TRACER_CADENCE_MS)
  }
  update(initial)
  return { update, dispose() { disposed = true; cancel() } }
}
