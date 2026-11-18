// Ordered dithering keeps the little groups of dots legible without adding noise.
const thresholds = [0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5]
const opacity = [0, .12, .4]

export function languageDots(canvas) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return () => {}
  let width, height, left, top, color
  let elapsed = 0, last = 0, timer

  function draw() {
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = color
    const t = elapsed / 1000
    const firstRow = Math.max(0, Math.ceil((top - 4.5) / 7))
    const firstCol = Math.max(0, Math.ceil((left - 4.5) / 7))
    for (let row = firstRow, y = 3 + row * 7; y < top + height; row++, y += 7) {
      for (let col = firstCol, x = 3 + col * 7; x < left + width; col++, x += 7) {
        const wave = Math.sin(x * .018 + y * .065 + t * .45 + .65 * Math.sin(x * .007 - y * .023 + t * .15))
        const threshold = thresholds[(row % 4) * 4 + col % 4] / 16
        const level = Math.max(0, Math.min(2, Math.floor(wave * .85 + .68 + threshold)))
        if (level) {
          ctx.globalAlpha = opacity[level]
          ctx.fillRect(x - left, y - top, 1.5, 1.5)
        }
      }
    }
  }

  function resize() {
    const field = canvas.getBoundingClientRect()
    const card = canvas.closest('article').getBoundingClientRect()
    width = field.width
    height = field.height
    left = Math.round(field.left - card.left)
    top = Math.round(field.top - card.top)
    const ratio = Math.min(devicePixelRatio, 2)
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    color = getComputedStyle(canvas).color
    draw()
  }
  resize()
  new ResizeObserver(resize).observe(canvas)
  new MutationObserver(resize).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return (running, reduced) => {
    clearInterval(timer)
    if (reduced) { elapsed = 0; draw() }
    if (!running) return
    last = performance.now()
    timer = setInterval(() => {
      const now = performance.now()
      elapsed += Math.min(now - last, 150)
      last = now
      draw()
    }, 80)
  }
}
