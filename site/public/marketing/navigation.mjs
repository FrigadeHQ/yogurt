const shell = document.querySelector('.sticky-header')
const header = shell.querySelector('.site-header')
const wordmark = header.querySelector('.wordmark')
const nav = header.querySelector('nav')
const toggle = nav.querySelector('.theme-toggle')
const hero = document.querySelector('.hero')
const [left, middle, right] = shell.querySelector('.nav-surface').children
const reduced = matchMedia('(prefers-reduced-motion: reduce)')
let geometry, position = 0, velocity = 0, target = 0, frame = 0, lastTime = 0

function paint() {
  const { width, height, inset, pillHeight, pillTop, logoShift, navShift } = geometry
  const surfaceHeight = height + 1 + (pillHeight - height - 1) * position
  const scale = surfaceHeight / height
  const top = -1 + (pillTop + 1) * position
  const endX = -(height + 1) / 2 * (1 - position) + inset * position
  const seam = endX + surfaceHeight / 2
  // Cover both antialiased joins so the page cannot show through the pill.
  left.style.transform = `translate(${endX}px, ${top}px) scale(${scale})`
  middle.style.transform = `translate(${seam - 2}px, ${top}px) scale(${width - 2 * seam + 4}, ${scale})`
  right.style.transform = `translate(${width - seam}px, ${top}px) scale(${scale})`
  const dy = (pillTop + (pillHeight - height) / 2) * position
  wordmark.style.transform = `translate(${logoShift * position}px, ${dy}px)`
  nav.style.transform = `translate(${navShift * position}px, ${dy}px)`
}

function settle() {
  cancelAnimationFrame(frame)
  frame = lastTime = velocity = 0
  position = target
  paint()
}

function tick(now) {
  let elapsed = lastTime ? Math.min((now - lastTime) / 1000, .048) : 1 / 60
  lastTime = now
  // Short integration steps keep the spring stable when a frame runs late.
  while (elapsed > .0001) {
    const step = Math.min(elapsed, .006)
    velocity += ((target - position) * 310 - velocity * 27.5) * step
    position += velocity * step
    elapsed -= step
  }
  if (Math.abs(position - target) < .00016 && Math.abs(velocity) < .004) {
    settle()
    return
  }
  paint()
  frame = requestAnimationFrame(tick)
}

function update(immediate = false) {
  shell.toggleAttribute('data-scrolled', scrollY > 1)
  // A small dead band keeps trackpad jitter at the hero edge from reversing the spring.
  target = Number(scrollY >= geometry.threshold - (target ? 12 : 0))
  if (immediate) settle()
  else if (position !== target || frame) {
    if (reduced.matches || document.hidden) settle()
    else if (!frame) frame = requestAnimationFrame(tick)
  }
}

function measure() {
  const { left, right, height } = header.getBoundingClientRect()
  const width = shell.clientWidth
  const phone = matchMedia('(max-width: 760px)').matches
  const pad = phone ? 10 : 14
  // The theme toggle is absolutely positioned just before the links.
  const controlsWidth = nav.offsetWidth - Math.min(0, toggle.offsetLeft)
  const pillWidth = Math.min(width - 8, 2 * pad + wordmark.offsetWidth + (phone ? 12 : 26) + controlsWidth)
  const inset = (width - pillWidth) / 2
  geometry = {
    width, height, inset, pillTop: phone ? 8 : 10, pillHeight: phone ? 48 : 52,
    logoShift: inset + pad - left, navShift: width - inset - pad - right,
    threshold: hero.getBoundingClientRect().bottom + scrollY - height,
  }
  update(true)
}

measure()
shell.toggleAttribute('data-ready', true)
const resize = new ResizeObserver(measure)
for (const el of [shell, header, wordmark, toggle, nav, hero]) resize.observe(el)
window.addEventListener('scroll', () => update(), { passive: true })
window.addEventListener('pageshow', measure)
document.addEventListener('visibilitychange', () => update(true))
reduced.addEventListener('change', () => update(true))
document.addEventListener('focusin', ({ target }) => {
  if (shell.contains(target) || target.closest('dialog, .skip') || !target.matches(':focus-visible')) return
  requestAnimationFrame(() => {
    if (document.activeElement !== target) return
    const { top, bottom, height } = target.getBoundingClientRect()
    const clearance = geometry.height + 8
    if (bottom > 0 && top < clearance && height <= innerHeight - clearance) {
      scrollBy({ top: top - clearance, behavior: 'instant' })
    }
  })
})
