import WebRtcAec3 from '@ennuicastr/webrtcaec3.js'
import { FRAME, type Canceller } from './aec'

/**
 * WebRTC's echo canceller (AEC3, the one Chrome, PulseAudio and PipeWire use), built for WebAssembly
 * (@ennuicastr/webrtcaec3.js, BSD; pinned in package.json, checked by the lockfile's hash). It runs inside Yogurt the
 * same way on Mac, Windows and Linux, on the 16 kHz audio going to whisper: about 2% of one core.
 * Loaded once (a few tens of ms); until then, or if it can't load, the mic goes to whisper as it is.
 */
let mod: WebRtcAec3.WebRtcAec3 | null = null
let loading: Promise<void> | undefined

export function loadAec3(): Promise<void> {
  loading ??= WebRtcAec3().then((m) => { mod = m }, (e) => { console.error('ASR the echo canceller could not load: the mic is transcribed as it is', e) })
  return loading
}

/** a canceller for one meeting, or null before it has loaded */
export function aec3(): Canceller | null {
  if (!mod) return null
  // 16 kHz, whisper's rate: AEC3 works at it directly (one band), as well as at 32 or 48 kHz on this audio and cheaper
  const a = new mod.AEC3(16000, 1, 1)
  const ref = [new Float32Array(FRAME)], mic = [new Float32Array(FRAME)], out = [new Float32Array(FRAME)]
  return {
    analyze: (x) => { ref[0].set(x); a.analyze(ref) },
    process: (x, o) => { mic[0].set(x); a.process(out, mic); o.set(out[0]) },
    free: () => a.free(),
  }
}
