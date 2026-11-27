import { describe, expect, it } from 'vitest'
import { floatingType, floatOverFullScreen } from '../src/main/float'

describe('floating windows (widget, card)', () => {
  it('show over full-screen apps and keep Yogurt in the Dock', () => {
    const calls: unknown[][] = []
    floatOverFullScreen({ setAlwaysOnTop: (...a: unknown[]) => calls.push(['top', ...a]), setVisibleOnAllWorkspaces: (...a: unknown[]) => calls.push(['all', ...a]) })
    expect(calls).toEqual([
      ['top', true, 'floating'],
      // without skipTransformProcessType Electron turns the whole app into a menu-bar-only one and the Dock icon goes
      ['all', true, { visibleOnFullScreen: true, skipTransformProcessType: true }],
    ])
  })
})

describe('floating window type', () => {
  it("a Mac keeps the widget's non-activating panel and the card's plain window", () => {
    expect(floatingType('darwin', 'panel')).toBe('panel')
    expect(floatingType('darwin')).toBeUndefined()
  })
  it('Windows and Linux use a tool window: never in Alt+Tab or the taskbar, kept above (no panels there)', () => {
    for (const os of ['win32', 'linux']) {
      expect(floatingType(os, 'panel')).toBe('toolbar')
      expect(floatingType(os)).toBe('toolbar')
    }
    expect(floatingType('win32', 'panel', false)).toBe('toolbar')
  })
  it('Linux makes a window that never takes focus a notification, which window managers never focus (#193)', () => {
    // a toolbar that refuses focus still gets it on some (Mango on Wayland): the keyboard is then stuck on Yogurt
    expect(floatingType('linux', 'panel', false)).toBe('notification')
    expect(floatingType('linux', undefined, false)).toBe('notification')
    expect(floatingType('darwin', 'panel', false)).toBe('panel')
  })
})
