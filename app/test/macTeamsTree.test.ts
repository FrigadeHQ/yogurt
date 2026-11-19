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
})
