import { refreshSummary, hour, navStars } from './stars-data.mjs'

const section = document.querySelector('#progress'),
  number = section.querySelector('.stat-value'),
  clip = section.querySelector('.chart-clip'),
  chart = section.querySelector('.star-chart'),
  points = Array.from(section.querySelector('.chart-line').points),
  reduce = matchMedia('(prefers-reduced-motion: reduce)')
let total = Number(number.textContent.replaceAll(',', ''))
const format = new Intl.NumberFormat('en')
number.setAttribute('aria-hidden', 'true')
number.parentElement.setAttribute('aria-label', `${format.format(total)} GitHub stars`)
const tailGaps = [3000, 8000, 15000, 24000, 35000, 48000]
let tailSize = Math.min(tailGaps.length, total),
  base = total - tailSize
let started = false,
  visible = false,
  finished = reduce.matches,
  clock = null,
  raf = 0,
  tailStage = false,
  tailValue = base,
  tailTimer = 0,
  tailRemaining = tailGaps[0],
  tailMark = 0
// Interpolate the same straight segment that is visible at the clipping edge.
function heightAt(progress) {
  if (progress === 0 || progress === 1 || points.length < 2) return progress
  const { width, height } = chart.viewBox.baseVal
  const x = width * progress
  let left = 0, right = points.length - 1
  while (right - left > 1) {
    const middle = (left + right) >>> 1
    if (points[middle].x <= x) left = middle
    else right = middle
  }
  const a = points[left], b = points[right]
  const t = b.x === a.x ? 1 : (x - a.x) / (b.x - a.x)
  const y = a.y + (b.y - a.y) * t
  const lastHeight = height - points.at(-1).y
  return lastHeight > 0 ? Math.min(1, (height - y) / lastHeight) : progress
}
function paint(progress) {
  clip.style.transform = 'scaleX(' + progress + ')'
  updateCount(heightAt(progress))
}
function updateCount(progress) {
  number.textContent = format.format(Math.round((finished ? total : base) * progress))
}
function stop() {
  cancelAnimationFrame(raf)
  raf = 0
  clock?.pause()
  if (tailTimer) {
    clearTimeout(tailTimer)
    tailTimer = 0
    tailRemaining = Math.max(0, tailRemaining - (performance.now() - tailMark))
  }
}
function rest() {
  finished = true
  tailStage = false
  clock?.cancel()
  clock = null
  updateCount(1)
  section.dataset.stars = 'complete'
}
function scheduleTail() {
  if (tailTimer || !visible || document.hidden || reduce.matches || finished) return
  tailMark = performance.now()
  tailTimer = setTimeout(() => {
    tailTimer = 0
    tailValue = Math.min(total, tailValue + 1)
    tailRemaining = tailGaps[tailValue - base] ?? 0
    number.textContent = format.format(tailValue)
    if (tailValue === total) rest()
    else scheduleTail()
  }, tailRemaining)
}
function finishCountUp() {
  paint(1)
  clock?.cancel()
  clock = null
  if (!tailSize) {
    rest()
    return
  }
  tailStage = true
  tailValue = base
  section.dataset.stars = 'settling'
  scheduleTail()
}

function tick() {
  if (reduce.matches) {
    sync()
    return
  }
  if (!visible || document.hidden) {
    stop()
    return
  }
  const progress = clock.effect.getComputedTiming().progress ?? 0
  paint(progress)
  if (clock.playState === 'finished' || progress >= 1) {
    raf = 0
    finishCountUp()
    return
  }
  raf = requestAnimationFrame(tick)
}
function sync() {
  if (reduce.matches) {
    stop()
    clock?.cancel()
    clock = null
    finished = true
    paint(1)
    section.dataset.stars = 'still'
    return
  }
  if (!visible || document.hidden) {
    stop()
    return
  }
  if (!started && !finished) return
  if (finished) return
  if (tailStage) {
    scheduleTail()
    return
  }
  if (!clock) {
    // A timing-only effect lets one frame update both the clip and the count.
    clock = new Animation(new KeyframeEffect(null, [], {
      duration: 1800, easing: 'cubic-bezier(.30,.60,.40,1)', fill: 'both',
    }), document.timeline)
    clock.play()
    paint(0)
  } else clock.play()
  section.dataset.stars = 'playing'
  if (!raf) raf = requestAnimationFrame(tick)
}
paint(reduce.matches ? 1 : 0)
new IntersectionObserver(([entry]) => {
  visible = entry.isIntersecting && entry.intersectionRatio > 0
  if (entry.intersectionRatio >= .55) started = true
  sync()
}, {threshold: [0, .55]}).observe(section.querySelector('.oss-history'))
document.addEventListener('visibilitychange', sync)
reduce.addEventListener('change', sync)

const age = document.querySelector('[data-latest-age]')
const date = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' })
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'always' })
function update() {
  const published = new Date(age.dateTime)
  const minutes = Math.floor((Date.now() - published.getTime()) / 60000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  age.dataset.recent = String(minutes >= 0 && days < 7)
  const label =
    minutes < 0 || days >= 30
      ? date.format(published)
      : minutes < 1
      ? 'just now'
      : minutes < 60
      ? relative.format(-minutes, 'minute')
      : hours < 48
      ? relative.format(-hours, 'hour')
      : relative.format(-days, 'day')
  age.textContent = 'Released ' + label
  age.title = published.toLocaleString()
}
update()
setInterval(() => {
  if (!document.hidden) update()
}, 60000)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) update()
})

let statusVisible=false
function syncStatusPulse(){age.dataset.pulsing=String(statusVisible&&!document.hidden&&!reduce.matches)}
new IntersectionObserver(([entry])=>{
  statusVisible=entry.isIntersecting
  syncStatusPulse()
}).observe(age)
document.addEventListener('visibilitychange',syncStatusPulse)
reduce.addEventListener('change',syncStatusPulse)

const nav = document.querySelector('.nav-stars')
const releaseCount = section.querySelector('.oss-calendar .oss-figure')
const releaseLink = section.querySelector('.oss-latest')
const version = releaseLink.querySelector('.release-version strong')
const built = {
  capturedAt: section.dataset.capturedAt,
  count: total,
  releases: Number(releaseCount.textContent.replaceAll(',', '')),
  latest: { tag: version.textContent, published: age.dateTime },
}
let nextCheck = 0
let lastSummary = built
async function refresh() {
  if (document.hidden || Date.now() < nextCheck) return
  nextCheck = Date.now() + hour
  let storage
  try { storage = window.localStorage } catch {}
  const data = await refreshSummary(lastSummary, { storage, getJSON: async url => {
    const response = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json' }, credentials: 'omit', signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw Error('GitHub unavailable')
    return response.json()
  } })
  lastSummary = data
  if (data.count !== total) {
    const ticks = tailValue - base
    total = data.count
    tailSize = Math.min(tailGaps.length, total)
    base = total - tailSize
    tailValue = Math.min(total, base + ticks)
    const label = format.format(total)
    nav.querySelector('span').textContent = navStars(total)
    nav.setAttribute('aria-label', 'Yogurt on GitHub, ' + label + ' stars')
    section.querySelector('.oss-history').setAttribute('aria-label', label + ' GitHub stars. View on GitHub')
    number.parentElement.setAttribute('aria-label', label + ' GitHub stars')
    if (finished) updateCount(1)
    else if (tailStage) number.textContent = format.format(tailValue)
  }
  releaseCount.textContent = format.format(data.releases)
  version.textContent = data.latest.tag
  releaseLink.href = 'https://github.com/FrigadeHQ/yogurt/releases/tag/' + encodeURIComponent(data.latest.tag)
  age.dateTime = data.latest.published
  update()
}
function beginRefresh() {
  refresh()
  setInterval(refresh, hour)
  document.addEventListener('visibilitychange', refresh)
}
if (document.readyState === 'complete') beginRefresh()
else window.addEventListener('load', beginRefresh, { once: true })
