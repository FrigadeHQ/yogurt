import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The Mac helper is Swift; this pins the order that matters (#111). Teams shows its Leave and Mute buttons to
// accessibility only once asked, and a Teams window counts as a call only when it has one of them, so the helper must
// ask Teams for its tree before it looks for a call window there, not after it found one.
const swift = readFileSync(join(__dirname, '../native/yogurt-mac/main.swift'), 'utf8')

describe('call-watch on the Teams desktop app (#111)', () => {
  it('asks Teams for its tree before looking for call controls', () => {
    const loop = swift.slice(swift.indexOf('func watchCalls'))
    const ask = loop.indexOf('askTree(')
    const look = loop.indexOf('callWindows(app')
    expect(ask).toBeGreaterThan(-1)
    expect(ask).toBeLessThan(look)
    expect(swift).toMatch(/func askTree[\s\S]*?hasPrefix\("com\.microsoft\.teams"\)/)
  })
  it("finds the Leave button deep in Teams' page: Chromium's own button search first, Teams' hangup-button id too (#111)", () => {
    const look = swift.slice(swift.indexOf('func hasCallControl'))
    expect(look.indexOf('AXUIElementsForSearchPredicate')).toBeGreaterThan(-1)
    expect(look.indexOf('AXUIElementsForSearchPredicate')).toBeLessThan(look.indexOf('queue.removeFirst'))
    expect(swift).toMatch(/AXDOMIdentifier"\)\) == "hangup-button"/)
  })
  it('says in the log why no window was a call', () => {
    expect(swift).toContain('"no-call-window (\\(lastControlLook))"')
  })
  it("asks Chrome for the Meet page the way screen readers do, and turns that off when the watch ends", () => {
    const ask = swift.slice(swift.indexOf('func askTree'), swift.indexOf('func resetTrees'))
    expect(ask).toContain('"AXEnhancedUserInterface" as CFString, kCFBooleanTrue')
    expect(swift).toMatch(/readDataToEndOfFile\(\); DispatchQueue\.main\.sync \{ resetTrees\(\) \}; exit\(0\)/)
  })
  it("reads a Meet tab in a browser whose window title is only the browser's name, and asks the window itself for the page (#123)", () => {
    expect(swift).toMatch(/"com\.ardia\.browser", "company\.thebrowser\.dia", "com\.microsoft\.edgemac", "com\.brave\.Browser", "com\.apple\.Safari"\]\.contains\(id\)/)
    const windows = swift.slice(swift.indexOf('func callWindows'), swift.indexOf('func watchCalls'))
    expect(windows).toContain('browserTitle(id)')
    expect(windows).toContain('kAXFocusedWindowAttribute')
    expect(windows).toContain('([w as! AXUIElement], title)')
    expect(swift.slice(swift.indexOf('func watchCalls'))).toContain('CFEqual(w, focused)')
    expect(swift).not.toContain('meetTabTitle')
    expect(swift).toMatch(/for w in wins\.prefix\(4\) \{ AXUIElementSetAttributeValue\(w, "AXManualAccessibility"/)
  })
})

