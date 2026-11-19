import { clientFrames, rollingDial } from './feature-motion.mjs'
import { languageDots } from './language-dots.mjs'

const reduce = matchMedia('(prefers-reduced-motion: reduce)')
function observeMotion(element, update) {
  let visible = false
  function sync() {
    update(visible && !document.hidden, reduce.matches)
  }
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting && entry.intersectionRatio >= .1
    sync()
  }, { threshold: [0, .1] }).observe(element)
  document.addEventListener('visibilitychange', sync)
  reduce.addEventListener('change', sync)
}

function animateInView(element, create) {
  let animations, pending, running = false
  function apply() {
    for (const animation of animations ?? []) {
      if (running) animation.play()
      else {
        animation.pause()
        if (reduce.matches) animation.currentTime = 0
      }
    }
  }
  observeMotion(element, async (visible, reduced) => {
    running = visible && !reduced
    if (running && !animations && !pending) {
      pending = true
      try { animations = [].concat(await create()) }
      catch { return } // Keep the server-rendered art if the word outlines are unavailable.
      finally { pending = false }
    }
    apply()
  })
}

const ring = document.querySelector('.dial-index')
observeMotion(ring.closest('article'), rollingDial(ring))

const tile = document.querySelector('.mcp-tiles')
const marks = Array.from(tile.querySelectorAll('.client-mark'))
let swaps = [], plainSwap, current = 0
observeMotion(tile.closest('article'), (visible, reduced) => {
  clearInterval(plainSwap)
  if (reduced) {
    // Local clients still change, without movement or a fade.
    if (swaps.length) {
      current = Math.floor((swaps[0].currentTime ?? 0) / 3600) % marks.length
      swaps.forEach(animation => animation.cancel())
      swaps = []
    }
    function show() {
      marks.forEach((mark, i) => { mark.style.opacity = i === current ? '1' : '0' })
    }
    show()
    if (visible) plainSwap = setInterval(() => { current = (current + 1) % marks.length; show() }, 3600)
    return
  }
  if (!swaps.length && visible) {
    swaps = marks.map((mark, i) => {
      mark.style.removeProperty('opacity')
      const animation = mark.animate(clientFrames(), {
        duration: 10800, iterations: Infinity, delay: -((marks.length - i) % marks.length * 3600 + 360),
      })
      animation.currentTime = current * 3600
      return animation
    })
  }
  swaps.forEach(animation => visible ? animation.play() : animation.pause())
})

const list = document.querySelector('.folder-list')
list.addEventListener('pointerover', (event) => {
  const row = event.target.closest('.folder-row')
  if (row && event.pointerType !== 'touch' && matchMedia('(any-hover: hover)').matches)
    list.style.setProperty('--hover-row', Array.from(list.children).indexOf(row))
})
// The highlight stays on the last folder the pointer was over.
list.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') list.style.removeProperty('--hover-row')
})

const canvas = document.querySelector('.language-dots')
const dots = languageDots(canvas)
observeMotion(canvas.closest('article'), (visible, reduced) => dots(visible && !reduced, reduced))
const word = document.querySelector('[data-morph]')
animateInView(word, async () => {
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
