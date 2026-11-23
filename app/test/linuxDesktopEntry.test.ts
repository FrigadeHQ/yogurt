import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DESKTOP_ID, desktopEntry, ensureDesktopEntry } from '../src/main/linuxDesktopEntry'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
function place(extra: Partial<Parameters<typeof ensureDesktopEntry>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yogurt-desktop-')); dirs.push(root)
  const icon = join(root, 'logo.png'); writeFileSync(icon, 'png')
  return { dataHome: join(root, 'home'), dataDirs: [join(root, 'usr')], icon, execPath: '/dev/electron', ...extra }
}
const own = (p: { dataHome: string }) => join(p.dataHome, 'applications', DESKTOP_ID)

describe('Linux: an installed desktop file gives GNOME the dock icon', () => {
  it('in dev: a hidden entry, named for the window class, with the logo copied next to it', () => {
    const p = place()
    expect(ensureDesktopEntry(p)).toBe('written')
    const text = readFileSync(own(p), 'utf8')
    expect(text).toContain('StartupWMClass=yogurt')
    expect(text).toContain('NoDisplay=true')
    expect(text).toContain(`Icon=${join(p.dataHome, 'icons/hicolor/256x256/apps/yogurt.png')}`)
    expect(readFileSync(join(p.dataHome, 'icons/hicolor/256x256/apps/yogurt.png'), 'utf8')).toBe('png')
  })

  it('from an AppImage: in the menu, launching the AppImage, quoted when its path has spaces', () => {
    const p = place({ appImage: '/home/me/My Apps/Yogurt.AppImage' })
    ensureDesktopEntry(p)
    const text = readFileSync(own(p), 'utf8')
    expect(text).toContain('Exec="/home/me/My Apps/Yogurt.AppImage" %U')
    expect(text).not.toContain('NoDisplay')
  })

  it('leaves it alone once current, and rewrites it when the AppImage moved', () => {
    const p = place({ appImage: '/a/Yogurt.AppImage' })
    ensureDesktopEntry(p)
    expect(ensureDesktopEntry(p)).toBe('current')
    expect(ensureDesktopEntry({ ...p, appImage: '/b/Yogurt.AppImage' })).toBe('written')
    expect(readFileSync(own(p), 'utf8')).toContain('Exec=/b/Yogurt.AppImage %U')
  })

  it('never writes over a package\'s own desktop file, in the system folders or the home folder', () => {
    const p = place()
    mkdirSync(join(p.dataDirs[0], 'applications'), { recursive: true })
    writeFileSync(join(p.dataDirs[0], 'applications', DESKTOP_ID), '[Desktop Entry]\n')
    expect(ensureDesktopEntry(p)).toBe('packaged')
    expect(existsSync(own(p))).toBe(false)

    const q = place()
    mkdirSync(join(q.dataHome, 'applications'), { recursive: true })
    writeFileSync(own(q), '[Desktop Entry]\nName=Mine\n')
    expect(ensureDesktopEntry(q)).toBe('packaged')
    expect(readFileSync(own(q), 'utf8')).toBe('[Desktop Entry]\nName=Mine\n')
  })

  it('the text is a valid entry: a header first, one key per line', () => {
    const lines = desktopEntry('/x', '/i.png', false).trim().split('\n')
    expect(lines[0]).toBe('[Desktop Entry]')
    expect(lines.slice(1).every((l) => /^[A-Za-z-]+=/.test(l))).toBe(true)
  })
})
