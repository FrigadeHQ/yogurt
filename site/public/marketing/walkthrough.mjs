import { syncFrameTheme } from './theme.mjs'

const tour = document.querySelector('.tour-layout')
const buttons = [...tour.querySelectorAll('button[data-scene]')]
const panels = buttons.map((button) => document.getElementById(button.getAttribute('aria-controls')))
const reduced = matchMedia('(prefers-reduced-motion: reduce)')
const timings = [
  [2.35, 3.6],
  [0, 6.5],
  [2.1, 4.2],
]
let active = 0,
  elapsed = 0,
  automatic = true,
  visible = false,
  previous = 0,
  frame = 0,
  lastSent = -1

function send(time) {
  panels[active]
    .querySelector('iframe')
    ?.contentWindow.postMessage({ type: 'yogurt-fragment-time', seconds: time }, location.origin)
}
function stop() {
  cancelAnimationFrame(frame)
  frame = previous = 0
}
function tick(now) {
  elapsed += previous ? Math.min(100, now - previous) / 1000 : 0
  previous = now
  const [offset, duration] = timings[active]
  const progress = Math.min(1, elapsed / (duration + 1.4))
  buttons[active].querySelector('.marker-rim').style.strokeDashoffset = String(1 - progress)
  if (elapsed - lastSent >= 0.05) {
    send(elapsed >= duration ? 99 : offset + elapsed)
    lastSent = elapsed
  }
  if (progress < 1) frame = requestAnimationFrame(tick)
  else if (automatic) select((active + 1) % buttons.length)
  else {
    send(99)
    stop()
  }
}
function sync() {
  stop()
  for (const panel of panels) {
    panel
      .querySelector('iframe')
      ?.contentWindow.postMessage(
        {
          type: 'yogurt-fragment-playing',
          playing: panel === panels[active] && visible && !document.hidden && !reduced.matches,
        },
        location.origin
      )
  }
  if (!visible || document.hidden || reduced.matches) return
  const art = panels[active].querySelector('.tour-frame')
  if (!art.querySelector('iframe')) {
    const child = document.createElement('iframe')
    child.title = buttons[active].innerText.trim()
    child.tabIndex = -1
    child.inert = true
    child.setAttribute('aria-hidden', 'true')
    child.setAttribute('sandbox', 'allow-scripts allow-same-origin')
    child.addEventListener('load', () => syncFrameTheme(child))
    child.src =
      '/marketing/app/frame.html?fragment=' +
      art.dataset.fragment +
      '&animate&theme=' +
      document.documentElement.dataset.theme
    art.append(child)
  }
  if (!art.hasAttribute('data-ready')) return
  if (elapsed < timings[active][1] + 1.4) frame = requestAnimationFrame(tick)
}
function select(next, manual = false) {
  if (manual) automatic = false
  active = next
  elapsed = 0
  lastSent = -1
  buttons.forEach((button, i) => {
    const selected = i === active,
      row = button.closest('.tour-item')
    row.dataset.selected = String(selected)
    button.setAttribute('aria-expanded', String(selected))
    row.querySelector('.tour-plus').textContent = selected ? '−' : '+'
    row.querySelector('.marker-rim').style.strokeDashoffset = '1'
    panels[i].hidden = !selected
    panels[i].setAttribute('aria-hidden', String(!selected))
  })
  sync()
}
buttons.forEach((button, i) => button.addEventListener('click', () => select(i, true)))
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.data?.type !== 'yogurt-fragment-ready') return
  const child = [...tour.querySelectorAll('iframe')].find((f) => f.contentWindow === event.source)
  if (!child) return
  syncFrameTheme(child)
  child.parentElement.dataset.ready = ''
  if (child.closest('.tour-panel') === panels[active]) {
    send(reduced.matches ? 99 : timings[active][0])
    sync()
  }
})
new IntersectionObserver(
  ([entry]) => {
    visible = entry.isIntersecting && entry.intersectionRatio >= 0.35
    sync()
  },
  { threshold: [0, 0.35] }
).observe(tour.querySelector('.tour-visual'))
reduced.addEventListener('change', () => {
  if (reduced.matches)
    for (const panel of panels) {
      panel.querySelector('iframe')?.remove()
      delete panel.querySelector('.tour-frame').dataset.ready
    }
  sync()
})
document.addEventListener('visibilitychange', sync)
