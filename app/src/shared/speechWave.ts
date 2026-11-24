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

const micDb = (me: number) => Number.isFinite(me) ? me * 60 - 60 : -Infinity

/**
 * The mic's noise floor: its quietest tenth over the last minute of level packets (10 a second), as the transcriber
 * measures it (asr/chunker.ts). A laptop mic in a quiet room can sit at -44 dB, where a fixed gate stays open for the
 * whole call. Until five seconds have come in there is no floor and only the fixed levels apply.
 */
export function micFloor(recent: number[], input: { me: number }) {
  recent.push(micDb(input.me))
  if (recent.length > 600) recent.shift()
  return recent.length < 50 ? -Infinity : [...recent].sort((a, b) => a - b)[Math.floor(recent.length / 10)]
}

/** Someone is talking at 10 dB over the floor (about 3x its loudness), and keeps talking down to 6 dB over it. */
export function speechSample(previous: SpeechAnchor, input: { me: number; them: number }, now: number, floor = -Infinity): SpeechAnchor {
  const db = micDb(input.me)
  const held = previous.speaking && now - previous.at <= SPEECH_PACKET_TIMEOUT
  return { ...speechAt(previous, now), at: now, speaking: db >= Math.max(-44.4, floor + 10) || (held && db > Math.max(-49.2, floor + 6)) }
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
