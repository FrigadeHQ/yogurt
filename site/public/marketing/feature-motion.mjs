// Choose another combination number each time. Excluding nearby distances prevents
// successive opposite sweeps from repeatedly landing back where they started.
export function dialTurn(from, direction, previousDistance, random = Math.random) {
  const minimum = 90, maximum = 350
  const lowerEnd = previousDistance == null ? maximum : Math.max(minimum, previousDistance - 45)
  const upperStart = previousDistance == null ? maximum : Math.min(maximum, previousDistance + 45)
  const lowSpan = lowerEnd - minimum
  const pick = random() * (lowSpan + maximum - upperStart)
  const distance = Math.round(pick < lowSpan ? minimum + pick : upperStart + pick - lowSpan)
  const to = from + direction * distance
  const travel = Math.round(220 + distance * 8.8)
  const settle = 200
  const duration = travel + settle + 2300 + Math.round(random() * 2100)
  const rotate = degrees => 'rotate(' + degrees + 'deg)'
  const frames = [
    { offset: 0, transform: rotate(from), easing: 'cubic-bezier(.45,0,.55,1)' },
    { offset: travel / duration, transform: rotate(to + direction * .55), easing: 'cubic-bezier(.23,1,.32,1)' },
    { offset: (travel + settle) / duration, transform: rotate(to) },
    { offset: 1, transform: rotate(to) },
  ]
  return { distance, to, duration, frames }
}

export function rollingDial(ring) {
  let position = -9, direction = 1, previousDistance, animation, running = false

  function next() {
    const turn = dialTurn(position, direction, previousDistance)
    if (!animation) {
      animation = ring.animate(turn.frames, { duration: turn.duration, delay: 420, fill: 'both' })
      animation.onfinish = () => {
        if (animation.playState === 'finished') next()
      }
    } else {
      animation.effect.setKeyframes(turn.frames)
      animation.effect.updateTiming({ duration: turn.duration, delay: 0 })
      animation.currentTime = 0
    }
    // Equivalent orientations at a stop keep the angle bounded over a long visit.
    position = (turn.to % 360 + 360) % 360
    direction *= -1
    previousDistance = turn.distance
    if (running) animation.play()
    else animation.pause()
  }

  return (visible, reduced) => {
    running = visible && !reduced
    if (!running) animation?.pause()
    else if (!animation || animation.playState === 'finished') next()
    else animation.play()
  }
}

// The negative phase starts on Claude. Only the two changing marks move during a handoff.
export function clientFrames() {
  return [
    { offset: 0, opacity: 0, transform: 'scale(.86)', easing: 'cubic-bezier(.23,1,.32,1)' },
    { offset: .03, opacity: 1, transform: 'scale(1)' },
    { offset: 1 / 3, opacity: 1, transform: 'scale(1)', easing: 'cubic-bezier(.45,0,.55,1)' },
    { offset: 1 / 3 + .024, opacity: 0, transform: 'scale(.92)' },
    { offset: 1, opacity: 0, transform: 'scale(.86)' },
  ]
}
