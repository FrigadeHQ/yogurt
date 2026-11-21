import { expect, it } from 'vitest'
// @ts-expect-error plain script, no types
import { electronArgs, sandboxProblems } from '../scripts/dev.mjs'

const wayland = { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }

it('pnpm dev on Wayland starts Electron on X11 itself: the app relaunching would end the dev server', () => {
  expect(electronArgs('linux', wayland, [])).toEqual(['--ozone-platform=x11'])
  expect(electronArgs('linux', wayland, ['--inspect'])).toEqual(['--ozone-platform=x11', '--inspect'])
})

it('never on X11, without XWayland, on a Mac or Windows, in fake mode, or over a switch given by hand', () => {
  expect(electronArgs('linux', { DISPLAY: ':0' }, [])).toEqual([])
  expect(electronArgs('linux', { WAYLAND_DISPLAY: 'wayland-0' }, [])).toEqual([])
  expect(electronArgs('darwin', wayland, [])).toEqual([])
  expect(electronArgs('win32', wayland, [])).toEqual([])
  expect(electronArgs('linux', { ...wayland, YOGURT_FAKE: '1' }, [])).toEqual([])
  expect(electronArgs('linux', wayland, ['--ozone-platform=wayland'])).toEqual(['--ozone-platform=wayland'])
})

const restricted = { platform: 'linux', env: {}, usernsRestricted: true, electronDir: '/home/sam/code/yogurt/node_modules/electron' }
const setuid = { uid: 0, mode: 0o104755 }

it("where the sandbox needs its setuid helper, pnpm dev says how to set it up instead of Electron's crash", () => {
  expect(sandboxProblems({ ...restricted, sandbox: { uid: 1000, mode: 0o100755 } })).toEqual([expect.stringContaining('sudo chmod 4755')])
  expect(sandboxProblems({ ...restricted, sandbox: setuid, electronDir: '/home/sam/Personal Docs/yogurt/node_modules/electron' })).toEqual([expect.stringContaining('space')])
  expect(sandboxProblems({ ...restricted, sandbox: setuid })).toEqual([])
})

it('nothing to say when user namespaces are allowed, off Linux, or with the sandbox turned off', () => {
  const broken = { ...restricted, sandbox: { uid: 1000, mode: 0o100755 }, electronDir: '/a b/electron' }
  expect(sandboxProblems({ ...broken, usernsRestricted: false })).toEqual([])
  expect(sandboxProblems({ ...broken, platform: 'darwin' })).toEqual([])
  expect(sandboxProblems({ ...broken, env: { ELECTRON_DISABLE_SANDBOX: '1' } })).toEqual([])
})
