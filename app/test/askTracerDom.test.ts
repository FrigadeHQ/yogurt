import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { attachAskTracer } from '../src/renderer/src/askTracer'
import { TRACER_CADENCE_MS, TRACER_DELAY_MS, TRACER_LAP_MS } from '../src/shared/askTracer'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it.each([
  { width: 394, light: true, duration: 550 },
  { width: 720, light: false, duration: 555 },
])('lights the left edge, turns the corner and settles at bottom centre ($width px, $duration ms)', ({ width, light, duration }) => {
  vi.useFakeTimers()
  const node = (tag: string) => {
    const element = {
      tag, style: {}, attrs: new Map<string, string>(),
      setAttribute(key: string, value: string) { this.attrs.set(key, value) },
      append: vi.fn(), remove: vi.fn(), animate: vi.fn((_frames: Keyframe[], _duration: number) => ({ cancel: vi.fn() })),
    }
    return element
  }
  const nodes: ReturnType<typeof node>[] = []
  const field = { value: '' }
  const doc = Object.assign(new EventTarget(), { activeElement: field, hidden: false,
    createElementNS: (_ns: string, tag: string) => { const element = node(tag); nodes.push(element); return element } })
  const media = Object.assign(new EventTarget(), { matches: false })
  let bounds = { width, height: 100 }, resize = () => {}
  const disconnect = vi.fn()
  const box = Object.assign(new EventTarget(), {
    querySelector: () => field, append: vi.fn(), matches: () => false,
    contains: (element: unknown) => element === field, getBoundingClientRect: () => ({ ...bounds, left: 0, top: 0 }),
  })
  vi.stubGlobal('document', doc)
  const appearance = Object.assign(new EventTarget(), { matches: light })
  vi.stubGlobal('window', { matchMedia: (query: string) => query.includes('color-scheme') ? appearance : media })
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect = disconnect
  })
  const tracer = attachAskTracer(box as unknown as HTMLFormElement)
  expect(nodes).toHaveLength(21)
  expect(nodes[0].attrs.get('aria-hidden')).toBe('true')
  expect([TRACER_DELAY_MS, TRACER_LAP_MS, TRACER_CADENCE_MS]).toEqual([300, 750, 8000])
  vi.advanceTimersByTime(299)
  expect(nodes[0].animate).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  const startY = 1 + 98 / 3
  const path = `M 1 ${startY} V 12 A 11 11 0 0 1 12 1 H ${width - 12} A 11 11 0 0 1 ${width - 1} 12 V 88 A 11 11 0 0 1 ${width - 12} 99 H ${width / 2}`
  const peak = light ? 0.2 : 0.4
  expect(nodes[0].animate).toHaveBeenCalledWith([
    { opacity: 0, easing: 'cubic-bezier(.18,.67,.46,1)' }, { opacity: peak, offset: 64 / duration },
    { opacity: peak, offset: 1 - 120 / duration, easing: 'cubic-bezier(.36,.02,.67,1)' }, { opacity: 0 },
  ], duration)
  const bodyCurve = 'cubic-bezier(.29,.79,.62,1)'
  const routePx = startY - 12 + (width - 24) + 76 + (width / 2 - 12) + 3 * Math.PI * 11 / 2
  let composite = 0
  for (const [i, segment] of nodes.slice(1).entries()) {
    expect(segment.attrs.get('d')).toBe(path)
    expect(segment.attrs.get('pathLength')).toBe('100')
    const [[frames, ms]] = segment.animate.mock.calls
    expect(ms).toBe(duration)
    const [start, leave, arrive, end] = frames
    expect(leave).toMatchObject({ offset: 48 / ms, easing: bodyCurve })
    expect(arrive).toMatchObject({ offset: 1 - 60 / ms, easing: 'cubic-bezier(.29,.79,.62,1)' })
    const [length, gap] = String(start.strokeDasharray).split(' ').map(Number)
    const tail = Number(start.strokeDashoffset)
    expect(length + gap).toBeCloseTo(200)
    expect(arrive.strokeDasharray).toBe(start.strokeDasharray)
    expect((tail - Number(leave.strokeDashoffset)) * routePx / 100).toBeCloseTo(3)
    expect(tail - Number(arrive.strokeDashoffset)).toBeCloseTo(100)
    expect(100 + Number(end.strokeDashoffset)).toBeCloseTo(tail * .04)
    const [tip, finalGap] = String(end.strokeDasharray).split(' ').map(Number)
    expect(tip + finalGap).toBeCloseTo(200)
    expect(tip).toBeCloseTo(length * .04)
    if (light || i === 19) {
      expect(length - tail).toBeCloseTo(0)
      expect(tip - Number(end.strokeDashoffset)).toBeCloseTo(100)
    }
    const alpha = Number((segment.style as CSSStyleDeclaration).opacity)
    composite = light ? composite + (1 - composite) * alpha : alpha
    expect(composite).toBeCloseTo(Math.sin(Math.PI * (i + .5) / 40) ** 2, 8)
  }
  vi.advanceTimersByTime(200)
  field.value = 'Draft'; box.dispatchEvent(new Event('input')); tracer.update()
  bounds = { width: 350, height: 190 }; resize()
  expect(nodes[0].attrs.get('viewBox')).toBe('0 0 350 190')
  expect(nodes[1].attrs.get('d')).toMatch(/ 189 H 175$/)
  expect(nodes[1].attrs.get('pathLength')).toBe('100')
  for (const element of nodes) expect(element.animate.mock.results[0].value.cancel).not.toHaveBeenCalled()
  vi.advanceTimersByTime(duration - 201)
  expect(nodes[0].animate.mock.results[0].value.cancel).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  for (const element of nodes) expect(element.animate.mock.results[0].value.cancel).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(24000)
  expect(nodes[0].animate).toHaveBeenCalledOnce()
  tracer.dispose()
  expect(disconnect).toHaveBeenCalledOnce()
  expect(nodes[0].remove).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  field.value = ''; box.dispatchEvent(new Event('focusin')); media.dispatchEvent(new Event('change'))
  expect(vi.getTimerCount()).toBe(0)
})

it('mirrors only the painted route around the centre of an RTL composer', () => {
  const css = readFileSync(new URL('../src/renderer/src/workspace.css', import.meta.url), 'utf8')
  expect(css).toMatch(/\.ask-box:dir\(rtl\) > \.ask-tracer \{ transform:scaleX\(-1\);transform-origin:center;/)
})

it('plays the opening under a resting or a moving pointer, as after a click', () => {
  vi.useFakeTimers()
  const nodes: { animate: ReturnType<typeof vi.fn> }[] = []
  const field = { value: '' }
  vi.stubGlobal('document', Object.assign(new EventTarget(), { activeElement: field, hidden: false,
    createElementNS: () => { const element = { namespaceURI: '', style: {}, setAttribute() {}, append() {}, remove() {}, animate: vi.fn(() => ({ cancel() {} })) }; nodes.push(element); return element } }))
  vi.stubGlobal('window', { matchMedia: () => Object.assign(new EventTarget(), { matches: false }) })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const open = () => {
    nodes.length = 0
    const box = Object.assign(new EventTarget(), { querySelector: () => field, append() {}, matches: () => true,
      contains: (element: unknown) => element === field, getBoundingClientRect: () => ({ width: 400, height: 100 }) })
    return { box, tracer: attachAskTracer(box as unknown as HTMLFormElement) }
  }
  const resting = open()
  vi.advanceTimersByTime(TRACER_DELAY_MS)
  expect(nodes[0].animate).toHaveBeenCalledOnce()
  resting.tracer.dispose()
  // clicking Ask leaves the pointer moving over the box; the opening lap still plays, like ⌘J
  const moving = open()
  moving.box.dispatchEvent(new Event('pointermove'))
  vi.advanceTimersByTime(TRACER_DELAY_MS)
  expect(nodes[0].animate).toHaveBeenCalledOnce()
  moving.tracer.dispose()
})
