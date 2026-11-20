import { refreshSummary, hour, navStars } from './stars-data.mjs'

const section = document.querySelector('#progress'),
  number = section.querySelector('.stat-value'),
  clip = section.querySelector('.chart-clip'),
  reduce = matchMedia('(prefers-reduced-motion: reduce)')
let total = Number(number.textContent.replaceAll(',', ''))
const format = new Intl.NumberFormat('en')
let started = false,
  visible = false,
  finished = reduce.matches,
  clock = null,
  raf = 0
// The count is always the real total. Only the line draws in.
function paint(progress) {
  clip.style.transform = 'scaleX(' + progress + ')'
}
function stop() {
  cancelAnimationFrame(raf)
  raf = 0
  clock?.pause()
}
function rest(state) {
  stop()
  clock?.cancel()
  clock = null
  finished = true
  paint(1)
  section.dataset.stars = state
}

function tick() {
  if (reduce.matches || !visible || document.hidden) {
    sync()
    return
  }
  const progress = clock.effect.getComputedTiming().progress ?? 0
  paint(progress)
  if (clock.playState === 'finished' || progress >= 1) {
    rest('complete')
    return
  }
  raf = requestAnimationFrame(tick)
}
function sync() {
  if (reduce.matches) {
    rest('still')
    return
  }
  if (!visible || document.hidden) {
    stop()
    return
  }
  if (!started || finished) return
  if (!clock) {
    clock = new Animation(new KeyframeEffect(null, [], {
      duration: 1800, easing: 'cubic-bezier(.30,.60,.40,1)', fill: 'both',
    }), document.timeline)
    paint(0)
  }
  clock.play()
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
const built = { capturedAt: section.dataset.capturedAt, count: total }
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
    total = data.count
    const label = format.format(total)
    number.textContent = label
    nav.querySelector('span').textContent = navStars(total)
    nav.setAttribute('aria-label', 'Yogurt on GitHub, ' + label + ' stars')
    section.querySelector('.oss-history').setAttribute('aria-label', label + ' GitHub stars. View on GitHub')
  }
}
function beginRefresh() {
  refresh()
  setInterval(refresh, hour)
  document.addEventListener('visibilitychange', refresh)
}
if (document.readyState === 'complete') beginRefresh()
else window.addEventListener('load', beginRefresh, { once: true })
