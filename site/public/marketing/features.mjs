const reduce = matchMedia('(prefers-reduced-motion: reduce)')
function inView(element, createAnimation) {
  let inViewport = false,
    pending = false,
    animation
  async function update() {
    if (!inViewport || document.hidden || reduce.matches) {
      animation?.pause()
      if (reduce.matches && animation)
        animation.currentTime =
          animation.effect.getTiming().iterations === Infinity ? 0 : animation.effect.getTiming().duration
      return
    }
    if (!animation && !pending) {
      pending = true
      try {
        animation = await createAnimation()
      } catch {
        return
      } finally {
        pending = false
      }
      update()
    } else if (animation && animation.playState !== 'finished') animation.play()
  }
  new IntersectionObserver(
    ([entry]) => {
      inViewport = entry.isIntersecting
      update()
    },
    { threshold: 0.1 }
  ).observe(element)
  document.addEventListener('visibilitychange', update)
  reduce.addEventListener('change', update)
}
const ring = document.querySelector('.dial-index')
inView(ring, () =>
  ring.animate([{ transform: 'rotate(-30deg)' }, { transform: 'rotate(0deg)' }], {
    duration: 1100,
    easing: 'cubic-bezier(.45,0,.55,1)',
    fill: 'both',
  })
)

const word = document.querySelector('[data-morph]')
inView(word, async () => {
  const response = await fetch('/marketing/assets/language-outlines.json')
  if (!response.ok) throw Error('Word outlines unavailable')
  const contours = await response.json()
  const words = contours.map((letters) =>
    letters
      .map((points) => {
        // A missing letter collapses to one point, with the same command count for interpolation.
        const coordinates = points.length === 2 ? Array.from({ length: 32 }, () => points).flat() : points
        let d = 'M' + coordinates[0] + ',' + coordinates[1]
        for (let i = 2; i < coordinates.length; i += 2) d += 'L' + coordinates[i] + ',' + coordinates[i + 1]
        return d + 'Z'
      })
      .join('')
  )
  const frames = []
  for (let i = 0; i < words.length; i++) {
    const d = 'path("' + words[i] + '")'
    frames.push(
      { d, offset: i / words.length },
      { d, offset: (i + 2 / 3) / words.length, easing: 'cubic-bezier(.77,0,.175,1)' }
    )
  }
  frames.push({ d: 'path("' + words[0] + '")', offset: 1 })
  const path = word.querySelector('path')
  path.setAttribute('d', words[0])
  return path.animate(frames, { duration: 1800 * words.length, iterations: Infinity })
})
