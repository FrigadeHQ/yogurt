import { homePage } from './site-page.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getActivity, refreshActivity, renderActivity, validSnapshot } from './activity.mjs'

const load = (name) => readFileSync(new URL(name, import.meta.url), 'utf8')
const saved = JSON.parse(load('../content/activity.json'))
assert(validSnapshot(saved))
for (const broken of [
  { week: [0] },
  { history: [null] },
  { latest: { tag: '<tag>' } },
  { count: 0 },
  {
    history: [
      [2, 3],
      [1, 4],
    ],
  },
])
  assert.equal(validSnapshot({ ...saved, ...broken }), false)

const now = new Date('2026-11-18T15:00:00Z')
const times = ['2026-11-11T23:59:59Z', '2026-11-12T00:00:00Z', '2026-11-18T12:00:00Z']
const releases = times.map((published_at, i) => ({ tag_name: 'v1.' + i, published_at }))
let requests = 0
const star = { user: { id: 1 }, starred_at: times[0] }
async function request(url, accept) {
  requests++
  if (url.includes('/releases?'))
    return [...releases, { ...releases[2], draft: true }, { ...releases[2], prerelease: true }]
  if (url.includes('/stargazers?')) {
    assert.equal(accept, 'application/vnd.github.star+json')
    return url.endsWith('page=1') ? Array(100).fill(star) : [star, { user: { id: 2 }, starred_at: times[2] }]
  }
  return { stargazers_count: 2 }
}
const fresh = await getActivity(undefined, request, now)
assert.equal(requests, 4)
assert.equal(fresh.count, 2)
assert.equal(fresh.releases, 3)
assert.equal(fresh.latest.tag, 'v1.2')
assert.deepEqual(fresh.week, [1, 0, 0, 0, 0, 0, 1])
assert.deepEqual(fresh.history, [
  [Date.parse(times[0]), 1],
  [Date.parse(times[2]), 2],
])
requests = 0
await getActivity(fresh, request, now)
assert.equal(requests, 2, 'Reuse fresh dated history')
const offline = () => {
  throw Error('offline')
}
assert.deepEqual(await refreshActivity(fresh, offline, now), fresh)
const partial = await refreshActivity(
  fresh,
  (url, accept) =>
    url.includes('/stargazers?')
      ? offline()
      : url.includes('/releases?')
      ? request(url, accept)
      : { stargazers_count: 3 },
  now
)
assert.deepEqual(partial.history, fresh.history)
assert.equal(partial.count, 3)
const notes = releases.map(row => ({ version: row.tag_name, published: row.published_at })).reverse()
const html = renderActivity(homePage(), fresh, notes)
assert(!html.includes('{{'))
assert(html.includes('Yogurt on GitHub, 2 stars'))
assert(html.includes('href="/updates#v1.2"'))
assert.equal((html.match(/class="week-day"/g) || []).length, 7)
assert(html.includes('aria-label="2 published Nov 12'))
assert(!html.includes('in 7 days'))
function chartVertices(page) {
  return page.match(/<polyline class="chart-line" points="([^"]+)"/)[1]
}
assert.match(html, /<g clip-path="url\(#history-trace\)">\s*<path class="chart-fill"[^>]*><\/path>\s*<polyline class="chart-line"[^>]*><\/polyline>\s*<\/g>/)
assert.doesNotMatch(html, /class="chart-dot"|point-overlay/)
assert.equal(chartVertices(html), '0.00,45.00 510.00,0.00')
assert.ok(html.includes('d="M' + chartVertices(html).replaceAll(' ', 'L') + 'L510 90L0 90Z"'))
const single = {...fresh, count: 1, history: fresh.history.slice(0, 1)}
assert.equal(chartVertices(renderActivity(homePage(), single, notes)), '510.00,0.00')
const fewer = {...fresh, count: 1}
assert.match(chartVertices(renderActivity(homePage(), fewer, notes)), /510\.00,45\.00$/)
assert(!load('../public/marketing/activity.mjs').includes('api.github.com'))
console.log('Published releases, UTC days, paginated dated stars, deduplication and outage fallbacks passed.')

// Drive the production animation clock without a browser. The real total is always the upper bound.
const { runInNewContext } = await import('node:vm')
const motionScript = load('../public/marketing/activity.mjs').replace(/^import [^\n]+\n/, '')
function chartPage(reduced = false) {
  const element = () => ({
    style: {},
    dataset: {},
    setAttribute() {},
    getBoundingClientRect: () => ({ width: 510, height: 90, top: 0, bottom: 90 }),
  })
  const number = { ...element(), textContent: '134', parentElement: element() },
    age = { ...element(), dateTime: '2026-11-01T00:00:00Z' }
  const object = { '.release-version strong': {textContent:'v1.2'}, '.oss-calendar .oss-figure': {textContent:'3'}, '.stat-value': number, '[data-latest-age]': age }
  // The nav already contains the published total. Tile playback must never write to it.
  const navCount = { get textContent() { return '134' }, set textContent(value) { assert.fail('Tile wrote ' + value + ' to the nav') } }
  object['.nav-stars'] = { ...element(), querySelector: () => navCount }
  object['.chart-line'] = { points: [{ x: 0, y: 90 }, { x: 255, y: 22.5 }, { x: 510, y: 0 }] }
  object['.star-chart'] = { viewBox: { baseVal: { width: 510, height: 90 } } }
  const query = (s) => (object[s] ??= Object.assign(element(), { querySelector: query, animate: animation }))
  let frame,
    timer,
    observe,
    visibility,
    passed = 0,
    current = 0
  let timing
  function animation(frames, options) {
    timing = { frames, options }
    return {
      pause() {},
      play() {},
      cancel() {},
      playState: 'running',
      effect: { getComputedTiming: () => ({ progress: current }) },
    }
  }
  const doc = {
    documentElement: element(),
    hidden: false,
    querySelector: query,
    createElement: () => ({ animate: animation }),
    addEventListener: (key, fn) => {
      visibility = fn
    },
  }
  runInNewContext(motionScript, {
    KeyframeEffect: class {
      constructor(target, frames, options) { Object.assign(this, {target, frames, options}) }
    },
    Animation: class {
      constructor(effect) { return animation(effect.frames, effect.options) }
    },
    document: doc,
    window: { addEventListener() {}, removeEventListener() {} },
    innerHeight: 800,
    Intl,
    Date,
    performance: { now: () => passed },
    matchMedia: () => ({ matches: reduced, addEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => 'ease' }),
    IntersectionObserver: class {
      constructor(fn) {
        observe ??= fn
      }
      observe() {}
    },
    requestAnimationFrame: (fn) => {
      frame = fn
      return 1
    },
    cancelAnimationFrame: () => {
      frame = null
    },
    setInterval() {},
    setTimeout: (fn, ms) => {
      timer = { fn, ms }
      return 1
    },
    clearTimeout: () => {
      timer = null
    },
  })
  return {
    number,
    enter: (ratio = 1) => observe([{ isIntersecting: true, intersectionRatio: ratio }]),
    clip: () => query('.chart-clip').style.transform,
    fill: () => query('.chart-fill').style.transform,
    timing: () => timing,
    at: p => { current = p; frame?.() },
    leave: () => observe([{ isIntersecting: false, intersectionRatio: 0 }]),
    finishCountUp: () => {
      current = 1
      frame?.()
    },
    timer: () => timer,
    advance: (ms) => {
      passed += ms
    },
    state: () => query('#progress').dataset.stars,
  }
}
const chart = chartPage()
assert.equal(chart.clip(), 'scaleX(0)')
assert.equal(chart.number.textContent, '134') // The count is the real total from the first paint.
chart.enter(.2)
assert.equal(chart.timing(), undefined)
chart.enter(.55)
assert.equal(chart.timing().options.duration, 1800)
chart.at(.5)
assert.equal(chart.clip(), 'scaleX(0.5)')
assert.equal(chart.number.textContent, '134')
assert.equal(chart.fill(), undefined)
chart.finishCountUp()
assert.equal(chart.clip(), 'scaleX(1)')
assert.equal(chart.number.textContent, '134')
assert(!chart.timer()) // Nothing keeps counting after the line has drawn.
assert.equal(chart.state(), 'complete')
const still = chartPage(true)
still.enter()
assert.equal(still.number.textContent, '134')
assert(!still.timer())
assert.equal(still.clip(), 'scaleX(1)')
assert.equal(still.timing(), undefined)
console.log('Chart line draw, a count that never changes while it draws, and reduced-motion rest passed.')

const template=homePage()
const featureSection=template.match(/<section aria-labelledby="features-title"[\s\S]*?<\/section>/)[0]
assert.doesNotMatch(featureSection, /<a\b|<iframe\b/)
for(const tag of template.match(/<a\b[^>]*>/g)){
  if(!tag.includes('href="https://github.com/'))continue
  if(tag.includes('/download/'))assert.doesNotMatch(tag,/target=/)
  else {
    assert.match(tag,/target="_blank"/)
    assert.match(tag,/rel="[^"]*\bnoopener\b[^"]*"/)
  }
}

const { refreshSummary, hour } = await import('../public/marketing/stars-data.mjs')
const built = { capturedAt: times[1], count: 12 }
let stored = null, calls = 0
const storage = {getItem: () => stored, setItem: (_, value) => { stored = value }}
const getJSON = async url => {
  assert.equal(url, 'https://api.github.com/repos/FrigadeHQ/yogurt')
  calls++
  return {stargazers_count:11}
}
const live = await refreshSummary(built, {storage, now:1000, getJSON})
assert.deepEqual(live, {...built, count:11})
assert.equal(calls,1)
const unavailable=async()=>{throw Error('403')}
assert.deepEqual(await refreshSummary(built,{storage,now:2000,getJSON:()=>assert.fail('cached')}),live)
assert.deepEqual(await refreshSummary(built,{storage,now:1000+hour,getJSON:unavailable}),live)
const newerBuild={...built,capturedAt:times[2],count:15}
assert.deepEqual(await refreshSummary(newerBuild,{storage,now:2000+hour,getJSON:unavailable}),newerBuild)
assert.deepEqual(await refreshSummary(built,{getJSON:unavailable}),built)
const legacy = {builtAt:built.capturedAt, at:1000, data:{count:19, releases:999, latest:{tag:'v9',published:times[2]}}}
stored = JSON.stringify(legacy)
assert.deepEqual(await refreshSummary(built,{storage,now:2000,getJSON}), {...built,count:19})
assert.equal(calls,1)
console.log('Hourly star refresh, legacy cache, newer deployments and rate-limit fallback passed.')
