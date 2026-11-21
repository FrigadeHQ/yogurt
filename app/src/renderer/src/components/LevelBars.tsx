import { useEffect, useRef } from 'react'
import { FALL, REST_OPACITY, RISE, SPEECH_PACKET_TIMEOUT, WAVE_PERIOD, silentSpeech, speechAt, speechBars, type SpeechAnchor } from '../../../shared/speechWave'

const WIDTH = 15, STROKE = 1.75, STUB = 3
type Props = { height: number; className?: string; testId: string; paused?: boolean; stillBars?: boolean; restOpacity?: number }

// Scale the centreline. Its non-scaling stroke retains the same round caps at every height.
const scale = (value: number, height: number) => `scaleY(${(STUB + value * (height - STUB) - STROKE) / (height - STROKE)})`

export function LevelBars({ height, className = '', testId, paused = false, stillBars = false, restOpacity = REST_OPACITY }: Props) {
  const ref = useRef<SVGSVGElement>(null)
  const recent = useRef(silentSpeech)
  useEffect(() => {
    const svg = ref.current!
    const bars = [...svg.querySelectorAll('line')]
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const clock = () => performance.timeOrigin + performance.now()
    let playing = false, animations: Animation[] = [], deadline: ReturnType<typeof setTimeout> | undefined
    const cancel = () => { for (const animation of animations) animation.cancel(); animations = [] }

    function sync() {
      clearTimeout(deadline)
      cancel()
      const now = clock(), anchor = recent.current, voice = speechAt(anchor, now)
      const visible = document.visibilityState === 'visible'
      playing = visible && !paused && anchor.speaking && now < anchor.at + SPEECH_PACKET_TIMEOUT
      const marker = stillBars && (paused || media.matches)
      const drive = visible && !paused ? voice.drive : 0
      const duration = playing ? (1 - drive) * RISE : drive * FALL
      const planAt = (ms: number) => speechBars({
        drive: Math.min(1, Math.max(0, drive + ms / (playing ? RISE : -FALL))),
        phase: voice.phase + ms,
      }, media.matches, restOpacity)
      const plan = planAt(0)
      bars.forEach((bar, i) => {
        const value = marker ? [.35, .525, .7, .525, .35][i] : plan.heights[i]
        bar.style.transform = scale(value, height)
        bar.style.opacity = String(marker ? .835 : plan.alpha[i])
      })
      svg.dataset.level = drive.toFixed(2)
      svg.dataset.live = !media.matches && !marker && (playing || duration > 0) ? '1' : '0'
      if (!visible || paused || marker || (!playing && duration === 0)) return

      // Submit a continuous timeline at gate changes. The display interpolates between samples
      // even when this window's JS frame callbacks run less frequently.
      const timelineStart = now - performance.timeOrigin
      const segment = (at: number, length: number, repeat: boolean) => {
        const count = Math.max(1, Math.ceil(length / (1000 / 60)))
        const samples = Array.from({ length: count + 1 }, (_, i) => planAt(at + length * i / count))
        for (const [i, bar] of bars.entries()) {
          const frames = samples.map(sample => ({ transform: scale(sample.heights[i], height), opacity: sample.alpha[i] }))
          const animation = bar.animate(frames, { duration: length, delay: at, iterations: repeat ? Infinity : 1, fill: 'forwards' })
          animation.startTime = timelineStart
          animations.push(animation)
        }
      }
      if (duration > 0) segment(0, duration, false)
      if (playing && !media.matches) segment(duration, WAVE_PERIOD, true)
      if (playing) armSilence(anchor)
      else deadline = setTimeout(sync, Math.ceil(duration) + 1)
    }

    function armSilence(anchor: SpeechAnchor) {
      clearTimeout(deadline)
      deadline = setTimeout(sync, Math.max(0, Math.ceil(anchor.at + SPEECH_PACKET_TIMEOUT - clock())))
    }
    const off = window.yogurt.widget.onLevel(({ speech }) => {
      const previous = recent.current
      recent.current = speech
      if (paused || document.visibilityState !== 'visible') return
      const now = clock(), wasStale = speech.at - previous.at > SPEECH_PACKET_TIMEOUT
      const speaking = speech.speaking && now < speech.at + SPEECH_PACKET_TIMEOUT
      if (previous.speaking !== speech.speaking || speaking !== playing || (wasStale && (speech.drive > 0 || speaking))) sync()
      else if (playing && !(stillBars && media.matches)) armSilence(speech)
      svg.dataset.level = speechAt(speech, now).drive.toFixed(2)
    })
    media.addEventListener('change', sync)
    document.addEventListener('visibilitychange', sync)
    sync()
    return () => { off(); clearTimeout(deadline); cancel(); media.removeEventListener('change', sync); document.removeEventListener('visibilitychange', sync) }
  }, [height, paused, stillBars, restOpacity])

  return <svg ref={ref} data-testid={testId} aria-hidden="true" width={WIDTH} height={height} viewBox={`0 0 ${WIDTH} ${height}`} className={`recording-wave ${className}`}>
    <g stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round">
      {Array.from({ length: 5 }, (_, i) => {
        const x = STROKE / 2 + i * (WIDTH - STROKE) / 4
        return <line key={i} x1={x} x2={x} y1={STROKE / 2} y2={height - STROKE / 2}
          vectorEffect="non-scaling-stroke" style={{ transform: scale(0, height), opacity: restOpacity }} />
      })}
    </g>
  </svg>
}
