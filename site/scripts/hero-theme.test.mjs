import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const controller = read('../public/marketing/hero-transcript.mjs').replace(/^import .*\n/gm, '')
const manifest = JSON.parse(read('../public/marketing/stills/manifest.json'))

for (const [scene, marker] of [['arrival', 'transcript-who'], ['answer', 'chat-answer'], ['phone', 'chat-answer']]) {
  const file = 'hero-light-' + scene + '.html'
  const poster = read('../public/marketing/stills/' + file)
  assert(poster.includes('data-marketing-theme="light"'))
  assert(poster.includes('href="/marketing/app/renderer.css"'))
  assert(poster.includes('data-testid="' + marker + '"'))
  assert.doesNotMatch(poster, /<script\b/i)
  assert.equal(createHash('sha256').update(poster).digest('hex'), manifest.posters[file].sha256)
}

function page(theme, wide, reduced) {
  const root = {dataset: {theme}}
  const demo = {dataset: {}, clientWidth: wide ? 800 : 350}
  const events = {}
  const children = new Set()
  demo.append = demo.prepend = node => { node.isConnected = true; children.add(node) }
  const media = initial => ({matches: initial, addEventListener(_, fn) { this.change = fn }})
  const desktop = media(wide), motion = media(reduced)
  let themeChanged
  const origin = 'https://example.test'
  runInNewContext(controller, {
    document: {
      documentElement: root, querySelector: () => demo, addEventListener() {},
      createElement: () => ({
        style: {setProperty() {}}, contentWindow: {postMessage() {}},
        setAttribute(key, value) { this[key] = value }, getAttribute(key) { return this[key] },
        remove() { this.isConnected = false; children.delete(this) },
      }),
    },
    window: {addEventListener(type, fn) { events[type] = fn }, dispatchEvent() {}},
    matchMedia: query => query.includes('min-width') ? desktop : motion,
    ResizeObserver: class { observe() {} }, IntersectionObserver: class { observe() {} },
    MutationObserver: class { constructor(fn) { themeChanged = fn } observe() {} },
    location: {origin, search: ''}, URLSearchParams, Event, onVoiceFrame() {},
    syncFrameTheme(frame) { assert.equal(demo.dataset.live, undefined); frame.theme = root.dataset.theme },
  })
  const find = name => [...children].find(node => node.className === name)
  return {
    poster: () => find('hero-light-poster'), frame: () => find('hero-renderer'),
    theme(value) { root.dataset.theme = value; themeChanged() },
    ready() { events.message({origin, source: this.frame().contentWindow, data: {type:'yogurt-hero-ready'}}) },
    reduce() { motion.matches = true; motion.change() },
  }
}

for (const theme of ['light', 'dark']) for (const desktop of [true, false]) for (const reduced of [true, false]) {
  const p = page(theme, desktop, reduced)
  const expected = '/marketing/stills/hero-light-' + (desktop ? (reduced ? 'answer' : 'arrival') : 'phone') + '.html'
  assert.equal(p.poster()?.src, theme === 'light' ? expected : undefined)
  assert.equal(Boolean(p.frame()), desktop && !reduced)
  p.theme('dark'); assert.equal(p.poster(), undefined)
  p.theme('light'); assert.equal(p.poster().src, expected)
  if (p.frame()) {
    p.ready()
    assert.equal(p.frame().theme, 'light')
    assert.equal(p.poster(), undefined)
    p.reduce()
    assert.equal(p.frame(), undefined)
    assert.match(p.poster().src, /hero-light-answer\.html$/)
  }
}
console.log('Themed hero posters, first live frame, phone and reduced-motion transitions passed.')
