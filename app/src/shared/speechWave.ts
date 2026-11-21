export const WAVE_PERIOD = 900
export const REST_OPACITY = .45
export const RISE = 300, FALL = 520
export const SPEECH_PACKET_TIMEOUT = 300
export type SpeechAnchor = { at: number; phase: number; drive: number; speaking: boolean }
export type MeterPacket = { me: number; them: number; speech: SpeechAnchor }
export const silentSpeech: SpeechAnchor = { at: 0, phase: 0, drive: 0, speaking: false }

/** Project the last capture packet onto a shared clock, including a missing packet's release. */
export function speechAt(anchor: SpeechAnchor, now: number) {
  const elapsed = Math.max(0, now - anchor.at)
  const rise = anchor.speaking ? Math.min(elapsed, SPEECH_PACKET_TIMEOUT) : 0
  const peak = Math.min(1, anchor.drive + rise / RISE)
  const fall = Math.min(elapsed - rise, peak * FALL)
  const drive = Math.max(0, peak - (elapsed - rise) / FALL)
  // Keep elapsed motion time so each renderer can wrap at its selected period.
  return { drive, phase: anchor.phase + rise + fall }
}

export function speechSample(previous: SpeechAnchor, input: { me: number; them: number }, now: number): SpeechAnchor {
  const db = Number.isFinite(input.me) ? input.me * 60 - 60 : -Infinity
  const held = previous.speaking && now - previous.at <= SPEECH_PACKET_TIMEOUT
  return { ...speechAt(previous, now), at: now, speaking: db >= -44.4 || (held && db > -49.2) }
}

export function speechBars({ drive, phase }: ReturnType<typeof speechAt>, reduced: boolean, restOpacity = REST_OPACITY) {
  const energy = drive * drive * (3 - 2 * drive)
  // The captured crest is 48 px tall and the trough 14 px. Our 3 px resting stub supplies part of that trough.
  const heights = Array.from({ length: 5 }, (_, i) => {
    const angle = reduced ? (i - 2) / 5 : (phase % WAVE_PERIOD) / WAVE_PERIOD + (i - 4) / 5
    const hump = (1 + Math.cos(2 * Math.PI * angle)) / 2
    return .70 * energy * (.11 + .89 * hump)
  })
  return { heights, alpha: heights.map(() => restOpacity + (1 - restOpacity) * energy) }
}

/** Latest possible rest time, for static, reduced-motion renderers if the input stream stops. */
export function speechRestAt(anchor: SpeechAnchor) {
  return anchor.at + (anchor.speaking ? SPEECH_PACKET_TIMEOUT + FALL : anchor.drive * FALL)
}
