import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const src = readFileSync(new URL('../public/marketing/walkthrough.mjs', import.meta.url), 'utf8').replace(
  /^import [^\n]+\n/,
  ''
)
const names = ['transcript', 'summary', 'ask']
function host(reduce = false) {
  let observe,
    frame,
    time = 1,
    change
  const events = {},
    messages = [],
    media = {
      matches: reduce,
      addEventListener: (type, fn) => {
        change = fn
      },
    }
  const panels = names.map((key) => {
    const art = {
      dataset: { fragment: key },
      querySelector: () => art.child,
      append(child) {
        art.child = child
        child.parentElement = art
        child.closest = () => panel
      },
      hasAttribute: () => Object.hasOwn(art.dataset, 'ready'),
    }
    const panel = {
      hidden: key !== 'transcript',
      art,
      querySelector: (s) => (s === 'iframe' ? art.child : art),
      setAttribute() {},
    }
    return panel
  })
  const buttons = names.map((key, i) => {
    const row = { dataset: {}, querySelector: () => ({ style: {} }) }
    const shape = { style: {} }
    return {
      getBoundingClientRect: () => ({ top: 0 }),
      getAttribute: () => 'panel-' + key,
      closest: () => row,
      querySelector: () => shape,
      getAnimations: () => [],
      setAttribute() {},
      addEventListener(type, fn) {
        this[type] = fn
      },
      innerText: key,
    }
  })
  const tour = {
    querySelector: () => ({}),
    querySelectorAll: (s) => (s === 'iframe' ? panels.map((p) => p.art.child).filter(Boolean) : buttons),
  }
  const doc = {
    documentElement: { dataset: { theme: 'dark' } },
    hidden: false,
    querySelector: () => tour,
    getElementById: (id) => panels[names.indexOf(id.slice(6))],
    addEventListener: (type, fn) => (events[type] = fn),
    createElement: () => ({
      contentWindow: { postMessage: (m) => messages.push(m) },
      setAttribute() {},
      addEventListener() {},
      remove() {
        delete this.parentElement.child
      },
    }),
  }
  vm.runInNewContext(src, {
    document: doc,
    window: { addEventListener: (type, fn) => (events[type] = fn) },
    location: { origin: 'https://example.test' },
    matchMedia: () => media,
    syncFrameTheme() {},
    IntersectionObserver: class {
      constructor(fn) {
        observe = fn
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
  })
  return {
    buttons,
    panels,
    messages,
    media,
    view: (v) => observe([{ isIntersecting: v, intersectionRatio: v ? 1 : 0 }]),
    motion: (v) => {
      media.matches = v
      change()
    },
    ready(i) {
      events.message({
        origin: 'https://example.test',
        source: panels[i].art.child.contentWindow,
        data: { type: 'yogurt-fragment-ready' },
      })
    },
    tick(n) {
      for (let i = 0; i < n; i++) {
        const next = frame
        frame = null
        next?.((time += 100))
      }
    },
    running: () => !!frame,
  }
}
const p = host()
assert(p.panels.every((p) => !p.art.child))
p.view(true)
assert(p.panels[0].art.child.src.includes('theme=dark'))
p.ready(0)
p.tick(10)
p.view(false)
assert(!p.running())
assert.equal(p.messages.at(-1).playing, false)
p.view(true)
p.tick(60)
assert(p.panels[1].art.child)
p.ready(1)
p.tick(90)
assert(p.panels[2].art.child)
p.buttons[0].click()
p.tick(100)
assert.equal(p.panels[0].hidden, false)
assert(!p.running())
assert.equal(p.messages.at(-1).seconds, 99)
p.motion(true)
assert(p.panels.every((p) => !p.art.child))
const quiet = host(true)
quiet.view(true)
quiet.buttons[2].click()
assert(!quiet.panels[2].hidden)
assert(!quiet.running())
assert(quiet.panels.every((p) => !p.art.child))
console.log(
  'Visible-only real frames, sequential scenes, manual selection, system theme and reduced-motion stills passed.'
)
