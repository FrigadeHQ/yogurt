// The desktop hero alone needs a sample clock. A static phone or reduced-motion view never loads audio measurements.
import { speechSignal } from './signal.mjs'

const desktop = matchMedia('(min-width:761px)')
const reduce = matchMedia('(prefers-reduced-motion: reduce)')
const listeners = new Set()
const state = { phase: 0, level: 0, bands: [0, 0, 0] }
let frame,
  lastTime,
  visible = false,
  loading = false,
  sample

async function loadSample() {
  loading = true
  try {
    const response = await fetch(new URL('./assets/speech-data.json', import.meta.url))
    if (!response.ok) throw Error('Sample unavailable')
    sample = speechSignal(await response.json())
  } catch {
    // Keep the demo timeline usable if the optional microphone levels are unavailable.
    sample = () => ({ level: 0, bands: [0, 0, 0] })
  }
  sync()
}
function tick(now) {
  if (lastTime !== undefined) state.phase += Math.min((now - lastTime) / 1000, 0.05)
  lastTime = now
  Object.assign(state, sample(state.phase))
  for (const render of listeners) render(state)
  frame = requestAnimationFrame(tick)
}
function sync() {
  cancelAnimationFrame(frame)
  lastTime = undefined
  if (!visible || document.hidden || !desktop.matches || reduce.matches || !listeners.size) return
  if (sample) frame = requestAnimationFrame(tick)
  else if (!loading) void loadSample()
}
export function onVoiceFrame(render) {
  listeners.add(render)
  render(state)
  sync()
}
desktop.addEventListener('change', sync)
reduce.addEventListener('change', sync)
document.addEventListener('visibilitychange', sync)
new IntersectionObserver(([entry]) => {
  visible = entry.isIntersecting
  sync()
}).observe(document.querySelector('.product-stage'))
