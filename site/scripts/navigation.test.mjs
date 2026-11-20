import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../public/marketing/navigation.mjs', import.meta.url), 'utf8')
const sheet = readFileSync(new URL('../public/marketing/site.css', import.meta.url), 'utf8')
assert.match(sheet, /\.nav-surface i:nth-child\(2\)\s*\{\s*width:\s*100%/)

function checkJoin(parts, width) {
  const values = part => part.style.transform.match(/-?[\d.]+/g).map(Number)
  const [left, , scaleX] = values(parts[1])
  const [rightCap] = values(parts[2])
  for (const dpr of [0.9, 1, 1.25, 1.5, 1.8, 2, 2.625]) {
    const paintedRight = left + Math.round(width * dpr) / dpr * scaleX
    const overlap = paintedRight - rightCap
    assert(overlap > 0.5 && overlap < 3.5, `center strip join at ${width}px and ${dpr}x: ${overlap}px`)
  }
}

for (const width of [1441, 1280, 761, 760, 390, 320]) {
  const phone = width < 761, height = phone ? 72 : 80
  const wordmark = { offsetWidth: phone ? 92 : 108, style: {} }
  const toggle = { offsetLeft: -44 }
  const download = { offsetHeight: phone ? 32 : 36 }
  const nav = { offsetWidth: 130, style: { setProperty(k, v) { this[k] = v } }, querySelector: selector => selector === '.theme-toggle' ? toggle : download }
  const header = {
    getBoundingClientRect: () => ({ left: 16, right: width - 16, height }),
    querySelector: selector => selector === 'nav' ? nav : wordmark,
  }
  const surface = { children: Array.from({ length: 3 }, () => ({ style: {} })) }
  const shell = { clientWidth: width, toggleAttribute() {}, querySelector: s => s === '.site-header' ? header : surface }
  let scroll, motionChange, frame, now = 0, reduced = false
  const context = {
    scrollY: 0, document: { querySelector: s => s === '.sticky-header' ? shell : hero, addEventListener() {} },
    window: { addEventListener(name, cb) { if (name === 'scroll') scroll = cb } },
    matchMedia: query => query.includes('reduce')
      ? { get matches() { return reduced }, addEventListener(_, cb) { motionChange = cb } }
      : { matches: phone },
    ResizeObserver: class { observe() {} },
    requestAnimationFrame(cb) { frame = cb; return 1 },
    cancelAnimationFrame() { frame = null },
  }
  const hero = { getBoundingClientRect: () => ({ bottom: 1000 - context.scrollY }) }
  vm.runInNewContext(source, context)
  const original = wordmark.style.transform
  const advance = () => {
    const next = frame
    frame = null
    next(now += 16)
    checkJoin(surface.children, width)
  }
  checkJoin(surface.children, width)
  const move = y => { context.scrollY = y; scroll() }
  move(1000 - height - 1)
  assert(!frame, 'the full header stays still over the app')
  move(1000 - height)
  advance()
  assert.notEqual(wordmark.style.transform, original)
  move(0)
  for (let i = 0; frame && i < 120; i++) advance()
  assert(!frame, 'an interrupted morph stops scheduling frames when settled')
  assert.equal(wordmark.style.transform, original)
  move(1000)
  advance()
  reduced = true
  motionChange()
  checkJoin(surface.children, width)
  const compact = wordmark.style.transform
  const x = el => parseFloat(el.style.transform.slice('translate('.length))
  const pillLeft = x(surface.children[0])
  const rightPad = width - pillLeft - (width - 16 + x(nav))
  const leftPad = 16 + x(wordmark) - pillLeft
  assert.equal(rightPad, ((phone ? 48 : 52) - download.offsetHeight) / 2)
  assert.equal(leftPad, phone ? 12 : 16)
  assert.equal(nav.style['--nav-download-radius'], download.offsetHeight / 2 + 'px')
  assert.notEqual(compact, original)
  assert(!frame, 'enabling reduced motion finishes the current morph')
  move(1000 - height - 5)
  assert.equal(wordmark.style.transform, compact, 'nearby scroll jitter keeps the same state')
  move(0)
  assert.equal(wordmark.style.transform, original)
  assert.equal(nav.style['--nav-download-radius'], '8px')
  assert(!frame, 'reduced motion changes states immediately')
}
console.log('Sticky navigation threshold, reversal, settling and reduced motion passed at desktop and phone widths.')

// GitHub's stargazers page is a 404 unless you are signed in to GitHub, so no link on the site may point at it
{
  const { readFileSync } = await import('node:fs')
  const home = readFileSync(new URL('../content/home.html', import.meta.url), 'utf8')
  if (/github\.com\/FrigadeHQ\/yogurt\/stargazers/.test(home)) throw new Error('the site links to the stargazers page, a 404 when signed out')
  console.log('ok - no link to the stargazers page')
}
