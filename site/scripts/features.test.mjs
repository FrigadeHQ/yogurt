import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dialTurn, rollingDial, clientFrames } from '../public/marketing/feature-motion.mjs'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const html = read('../content/home.html')
const folder = html.match(/<article class="feature-card card-folders"[\s\S]*?<\/article>/)[0]
assert.doesNotMatch(folder, /tabindex|<button|<a\s|role="button"/)
assert.match(folder, /aria-hidden="true" class="feature-visual/)
for (const [icon, label, color] of [
  ['rocket', 'Launch', 'violet'], ['users-round', 'Hiring', 'teal'], ['message-circle', 'Customer calls', 'amber'],
]) {
  const row = folder.match(new RegExp('data-folder-color="' + color + '"[\\s\\S]*?</div>'))[0]
  assert.ok(row.includes('lucide-' + icon) && row.includes('<span>' + label + '</span>'))
  assert.match(row, /width="16" height="16"/)
  assert.match(row, /stroke-width="1.75"/)
}

const arts = html.split('<article class="feature-card ').slice(1, 5).map(part => part.split('</article>')[0])
assert.equal(arts.filter(part => part.includes('language-dots')).length, 1)
assert.match(arts[3], /class="feature-visual">\s*<canvas class="language-dots"/)
assert.match(arts[2], /fill="url\(#wired-pad\)"/)
for (const name of ['Claude Desktop','ChatGPT desktop with a local plugin','Cursor']) {
  assert.ok(arts[2].includes('role="img" aria-label="' + name + '"'))
}

// Check every possible previous distance, including the boundaries of the
// excluded region, so a fresh sweep cannot overrun a revolution or retrace one.
const angle = frame => Number(frame.transform.match(/-?[\d.]+/)[0])
for (const direction of [1,-1]) {
  for (const previous of [undefined, ...Array.from({length:261}, (_, i) => 90 + i)]) {
    for (const pick of [0, .125, .5, .875, .999999]) {
      const turn = dialTurn(273, direction, previous, () => pick)
      const [start, peak, settled, end] = turn.frames
      assert.ok(turn.distance >= 90 && turn.distance <= 350)
      if (previous != null) assert.ok(Math.abs(turn.distance - previous) >= 45)
      assert.equal(angle(settled) - angle(start), direction * turn.distance)
      assert.ok(Math.abs(angle(peak) - angle(start)) < 360)
      assert.ok(Math.abs(angle(peak) - angle(settled)) < 1)
      assert.equal(angle(end), angle(settled))
      const travel = peak.offset * turn.duration
      assert.equal(Math.round(travel), Math.round(220 + turn.distance * 8.8))
      assert.equal(Math.round(settled.offset * turn.duration - travel), 200)
      const hold = Math.round((1 - settled.offset) * turn.duration)
      assert.ok(hold >= 2300 && hold <= 4400)
    }
  }
}

let rotor
const rolls = rollingDial({animate(frames, timing) {
  rotor = { frames, timing, effect:{
    setKeyframes(next) { rotor.frames = next },
    updateTiming(next) { rotor.timing = next },
  }, play(){this.playState='running'}, pause(){this.playState='paused'} }
  return rotor
}})
rolls(false,false)
rolls(true,true)
assert.equal(rotor,undefined)
rolls(true,false)
assert.equal(rotor.timing.delay,420)
let last
for (let n = 0; n < 64; n++) {
  const [start,,settled] = rotor.frames
  assert.equal(Math.sign(angle(settled)-angle(start)), n%2===0 ? 1 : -1)
  if (last!=null) assert.equal((angle(start) - last) % 360 || 0,0)
  last = angle(settled)
  rotor.playState='finished'
  rotor.onfinish()
  assert.equal(rotor.timing.delay,0)
}
rolls(false,false)
assert.equal(rotor.playState,'paused')
rolls(true,true)
assert.equal(rotor.playState,'paused')
rolls(true,false)
assert.equal(rotor.playState,'running')
const logo = clientFrames()
assert.deepEqual(logo.filter(f => f.opacity === 1).map(f => f.transform), ['scale(1)','scale(1)'])
assert.equal(logo[0].opacity, 0)
assert.equal(logo.at(-1).opacity, 0)
console.log('Feature artwork, accessible logo names, alternating dial stops and logo holds passed.')

// Run the homepage controller with a controllable viewport and clock.
const visible = new Map(), changes = [], events = new Map()
const preference = { matches: false, addEventListener: (_, callback) => changes.push(callback) }
globalThis.matchMedia = () => preference
globalThis.IntersectionObserver = class {
  constructor(callback) { this.callback = callback }
  observe(element) { visible.set(element, isVisible => this.callback([{isIntersecting:isVisible, intersectionRatio:Number(isVisible)}])) }
}
let tick
globalThis.setInterval = fn => { tick = fn; return 1 }
globalThis.clearInterval = () => { tick = undefined }
const clients = ['Claude','ChatGPT','Cursor'].map(() => ({
  style: { removeProperty(key) { delete this[key] } },
  animate() {
    this.motion = {
      currentTime: 0,
      play() { this.state = 'running' },
      pause() { this.state = 'paused' },
      cancel() { this.state = 'cancelled' },
    }
    return this.motion
  },
}))
const card = {}, inertArt = { closest: () => ({}), addEventListener() {} }
const tile = { closest: () => card, querySelectorAll: () => clients }
const selectors = { '.mcp-tiles': tile, '.language-dots': {...inertArt, getContext: () => null} }
globalThis.document = {
  hidden: false,
  querySelector: name => selectors[name] ?? inertArt,
  addEventListener(type,callback) {
    if (!events.has(type)) events.set(type, [])
    events.get(type).push(callback)
  },
}
await import('../public/marketing/features.mjs')
visible.get(card)(true)
assert.ok(clients.every(client => client.motion.state === 'running'))
visible.get(card)(false)
assert.ok(clients.every(client => client.motion.state === 'paused'))
preference.matches = true
changes.forEach(sync => sync())
assert.ok(clients.every(client => client.motion.state === 'cancelled'))
const shown = () => clients.map(client => client.style.opacity)
assert.deepEqual(shown(), ['1','0','0'])
assert.equal(tick,undefined)
visible.get(card)(true)
tick()
assert.deepEqual(shown(), ['0','1','0'])
document.hidden = true
events.get('visibilitychange').forEach(sync => sync())
assert.equal(tick, undefined)
document.hidden = false
events.get('visibilitychange').forEach(sync => sync())
tick()
assert.deepEqual(shown(), ['0','0','1'])
preference.matches = false
changes.forEach(sync => sync())
assert.equal(tick, undefined)
assert.ok(clients.every(client => client.motion.currentTime === 7200 && client.motion.state === 'running'))
console.log('Visible-only client loop, instant reduced-motion swaps and background pause passed.')
