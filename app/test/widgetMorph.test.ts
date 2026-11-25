import { describe, expect, it } from 'vitest'
import { WidgetIntent, widgetContains, widgetDragLayout, widgetExpanded, widgetLayout, widgetRestLayout, widgetSettings, widgetSizedPill } from '../src/shared/widgetMorph'
import { WidgetModel } from '../src/main/widgetModel'

describe('recorder hover intent', () => {
  it('opens after 220ms of rest and closes 480ms after leaving', () => {
    const intent = new WidgetIntent()
    intent.enter(0)
    expect(intent.tick(219)).toBeNull()
    intent.move(100)
    expect(intent.tick(319)).toBeNull()
    expect(intent.tick(320)).toBe(true)
    intent.leave(400)
    expect(intent.tick(879)).toBeNull()
    expect(intent.tick(880)).toBe(false)
  })
  it('cancels leaving on reentry and waits 650ms after a drag', () => {
    const intent = new WidgetIntent()
    intent.enter(0); intent.tick(220); intent.leave(300); intent.enter(400)
    expect(intent.tick(1000)).toBeNull()
    intent.leave(1000); intent.tick(1480)
    intent.enter(1500); intent.press()
    expect(intent.tick(2000)).toBeNull()
    intent.release(2000, true)
    expect(intent.tick(2649)).toBeNull()
    expect(intent.tick(2650)).toBe(true)
  })
  it('blocks closing during a press and post-drag quiet, including cancellation outside', () => {
    const intent = new WidgetIntent()
    intent.enter(0); intent.tick(220); intent.press(); intent.leave(300)
    expect(intent.tick(1000)).toBeNull()
    intent.release(1000, true)
    expect(intent.tick(1649)).toBeNull()
    expect(intent.tick(1650)).toBe(false)
  })
  it.each([false, true])('keeps an open card open through dragging and release, warning=%s', warning => {
    const intent = new WidgetIntent()
    intent.warning = warning
    intent.enter(0); intent.tick(220); intent.press(); intent.leave(300)
    expect(intent.tick(1000)).toBeNull()
    expect(intent.open).toBe(true)
    intent.enter(1100); intent.release(1200, true)
    expect(intent.tick(2000)).toBeNull()
    expect(intent.open).toBe(true)
  })
  it('shows a warning without hover and keeps it open until the warning clears', () => {
    const intent = new WidgetIntent()
    intent.warning = true
    expect(intent.tick(0)).toBe(true)
    intent.leave(100)
    expect(intent.tick(1000)).toBeNull()
    intent.warning = false; intent.leave(1000)
    expect(intent.tick(1480)).toBe(false)
  })
})

describe('recorder geometry', () => {
  const area = { x: -1200, y: -100, width: 1200, height: 900 }
  it.each([-1200, -200])('keeps the card and its shared edge fixed through mute, timer growth and unmute at x=%s', x => {
    const initial = widgetLayout({ x, y: 0, width: 75, height: 42 }, area)
    const left = x === area.x
    const edge = left ? initial.pill.x : initial.pill.x + initial.pill.width
    let frame = initial
    for (const width of [124, 75, 82, 131, 82, 75]) {
      const pill = widgetSizedPill(frame, width + 0.2)
      expect(pill).toEqual({ ...initial.pill, width, x: left ? edge : edge - width })
      frame = { ...frame, pill }
      expect(widgetExpanded(frame, false)).toEqual(widgetExpanded(initial, false))
    }
  })
  it.each([
    [-200, 0, -413, 0], [-1200, 0, -1200, 0], [-200, 750, -413, 346], [-1200, 750, -1200, 346],
  ])('keeps the pill at %s,%s and grows inward', (x, y, openX, openY) => {
    const pill = { x, y, width: 127, height: 42 }, result = widgetLayout(pill, area)
    expect(result.bounds.x + result.pill.x).toBe(x)
    expect(result.bounds.y + result.pill.y).toBe(y)
    expect(result.bounds.x + result.open.x).toBe(openX)
    expect(result.bounds.y + result.open.y).toBe(openY)
    expect(result.bounds.x).toBeGreaterThanOrEqual(area.x)
    expect(result.bounds.y).toBeGreaterThanOrEqual(area.y)
    expect(result.bounds.x + result.bounds.width).toBeLessThanOrEqual(0)
    expect(result.bounds.y + result.bounds.height).toBeLessThanOrEqual(800)
  })
  it('fits a small work area while preserving the pill location', () => {
    const result = widgetLayout({ x: 80, y: 130, width: 118, height: 42 }, { x: 0, y: 0, width: 250, height: 200 })
    expect(result.bounds).toEqual({ x: 0, y: 0, width: 250, height: 200 })
    expect(widgetExpanded(result, false)).toEqual(result.bounds)
    expect(result.pill).toMatchObject({ x: 80, y: 130 })
  })
  it.each([42, 180, 390, 446])('clamps the visible %spt surface at every edge and keeps room to open', height => {
    for (const y of [0, 700]) {
      const frame = widgetLayout({ x: -600, y, width: 127, height: 42 }, area)
      const up = frame.pill.y > frame.open.y
      const surface = height === 42 ? frame.pill : { ...frame.open, height, y: frame.open.y + (up ? frame.open.height - height : 0) }
      for (const dx of [-9999, 9999]) for (const dy of [-9999, 9999]) {
        const moved = widgetDragLayout(frame, surface, dx, dy, area)
        const left = moved.bounds.x + surface.x + moved.pill.x - frame.pill.x
        const top = moved.bounds.y + surface.y + moved.pill.y - frame.pill.y
        expect(left).toBe(dx < 0 ? area.x : area.x + area.width - surface.width)
        expect(top).toBe(dy < 0 ? area.y : area.y + area.height - surface.height)
        expect(moved.bounds.x).toBeGreaterThanOrEqual(area.x)
        expect(moved.bounds.y).toBeGreaterThanOrEqual(area.y)
        expect(moved.bounds.x + moved.bounds.width).toBeLessThanOrEqual(area.x + area.width)
        expect(moved.bounds.y + moved.bounds.height).toBeLessThanOrEqual(area.y + area.height)
        expect(widgetExpanded(moved, false)).toMatchObject({ width: 340, height: 390 })
        if (height === 390 || height === 446) {
          const resumedHeight = Math.min(height, moved.open.height)
          const resumedUp = moved.pill.y + moved.pill.height > moved.open.y + moved.open.height / 2
          expect(moved.bounds.x + moved.open.x).toBe(left)
          expect(moved.bounds.y + moved.open.y + (resumedUp ? moved.open.height - resumedHeight : 0)).toBe(top)
          expect(resumedHeight).toBe(height)
        }
      }
    }
  })
  it('keeps a fractional spring surface intact inside integer native bounds', () => {
    const frame = widgetLayout({ x: -600, y: 0, width: 127, height: 42 }, area)
    const surface = { ...frame.open, x: frame.open.x - 0.5, y: frame.open.y - 0.5, width: 341, height: 391 }
    for (const delta of [-9999, 9999]) {
      const moved = widgetDragLayout(frame, surface, delta, delta, area)
      expect(Object.values(moved.bounds).every(Number.isInteger)).toBe(true)
      expect(moved.bounds.width).toBeGreaterThanOrEqual(surface.width)
      expect(moved.bounds.height).toBeGreaterThanOrEqual(surface.height)
      const left = moved.bounds.x + surface.x + moved.pill.x - frame.pill.x
      const top = moved.bounds.y + surface.y + moved.pill.y - frame.pill.y
      expect(left).toBe(delta < 0 ? area.x : area.x + area.width - surface.width)
      expect(top).toBe(delta < 0 ? area.y : area.y + area.height - surface.height)
    }
  })
  it.each([false, true])('restores normal dimensions across repeated edge drags and reopen, warning=%s', warning => {
    const height = warning ? 446 : 390
    for (const y of [0, 700]) {
      let frame = widgetLayout({ x: -600, y, width: 127, height: 42 }, area)
      const expanded = widgetExpanded(frame, warning)
      let surface = { ...expanded, x: expanded.x + 100, y: expanded.y + (frame.up ? height - 180 : 0), width: 240, height: 180 }
      for (const [dx, dy] of [[-9999, -9999], [9999, 9999], [-9999, 9999], [9999, -9999], [-100, 100]]) {
        const dragged = widgetDragLayout(frame, surface, dx, dy, area)
        const visible = {
          ...surface,
          x: dragged.bounds.x + surface.x + dragged.pill.x - frame.pill.x,
          y: dragged.bounds.y + surface.y + dragged.pill.y - frame.pill.y,
        }
        const restored = widgetRestLayout(dragged, area, height)
        const reopened = widgetExpanded(restored, warning)
        expect(reopened).toMatchObject({ width: 340, height })
        expect(restored.bounds.x + reopened.x).toBeGreaterThanOrEqual(area.x)
        expect(restored.bounds.y + reopened.y).toBeGreaterThanOrEqual(area.y)
        expect(restored.bounds.x + reopened.x + reopened.width).toBeLessThanOrEqual(area.x + area.width)
        expect(restored.bounds.y + reopened.y + reopened.height).toBeLessThanOrEqual(area.y + area.height)
        // Growing the native frame does not move the frozen surface; a settled card stays at its drop point.
        expect(restored.bounds.x + surface.x + restored.pill.x - frame.pill.x).toBe(visible.x)
        expect(restored.bounds.y + surface.y + restored.pill.y - frame.pill.y).toBe(visible.y)
        if (surface.width === 340) {
          expect(restored.bounds.x + reopened.x).toBe(visible.x)
          expect(restored.bounds.y + reopened.y).toBe(visible.y)
        }
        frame = restored; surface = reopened
      }
    }
  })
  it('excludes transparent corners and includes the full animated surface', () => {
    const surface = { x: 200, y: 10, width: 118, height: 42, radius: 10 }
    expect(widgetContains(surface, 200, 10)).toBe(false)
    expect(widgetContains(surface, 205, 15)).toBe(true)
    expect(widgetContains(surface, 190, 30)).toBe(false)
    expect(widgetContains({ ...surface, x: 0, width: 340, height: 390, radius: 16 }, 190, 300)).toBe(true)
  })
})

it('offers Settings only for missing microphone or call audio', () => {
  const model = new WidgetModel()
  model.start({ id: 'meeting', title: 'Review', startedAt: 0 })
  expect(widgetSettings(model.view(0)!.note)).toBeNull()
  model.warn('falling-behind')
  expect(widgetSettings(model.view(0)!.note)).toBeNull()
  model.warn('no-system-audio')
  expect(widgetSettings(model.view(0)!.note)).toBe('systemAudio')
  model.warn('no-mic')
  expect(widgetSettings(model.view(0)!.note)).toBe('mic')
  model.hiccup(0)
  expect(widgetSettings(model.view(1)!.note)).toBeNull()
  expect(widgetSettings(model.view(4001)!.note)).toBe('mic')
})
