import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Electron's window class on Linux is package.json's desktopName minus .desktop; GNOME finds the app's icon only
 * through an installed desktop file of this name (it ignores the window's own icon), so without one it shows a gear */
export const DESKTOP_ID = 'yogurt.desktop'
/** marks the file as Yogurt's own, so it is kept up to date and never confused with a package's */
const MARK = 'X-Yogurt-Managed=true'

export interface DesktopEntryPlace {
  /** XDG_DATA_HOME, else ~/.local/share */
  dataHome: string
  /** XDG_DATA_DIRS, split: where a package (a .deb, a distro) would have put its own desktop file */
  dataDirs: string[]
  /** the logo to show */
  icon: string
  /** the AppImage's path when started from one: the menu entry then launches it */
  appImage?: string
  /** Electron's own binary, for a hidden entry in dev */
  execPath: string
}

/** the desktop file's text: in the menu for an AppImage, hidden in dev (there it only names the icon) */
export function desktopEntry(exec: string, icon: string, hidden: boolean): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Yogurt',
    'Comment=Meeting notes that stay on your computer',
    `Exec=${exec} %U`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=Office;',
    'StartupWMClass=yogurt',
    ...(hidden ? ['NoDisplay=true'] : []),
    MARK,
    '',
  ].join('\n')
}

/** quoted for a desktop file's Exec line when the path has spaces or quotes */
const quote = (path: string): string => (/[\s"'\\$`]/.test(path) ? `"${path.replace(/(["\\$`])/g, '\\$1')}"` : path)

/** Writes Yogurt's desktop file and its icon under dataHome, unless a package installed one already. Rewrites only
 * when the text changed (the AppImage moved). Returns what it did, for the log. */
export function ensureDesktopEntry(place: DesktopEntryPlace): 'written' | 'current' | 'packaged' {
  const own = join(place.dataHome, 'applications', DESKTOP_ID)
  for (const dir of place.dataDirs) {
    const other = join(dir, 'applications', DESKTOP_ID)
    if (other !== own && existsSync(other)) return 'packaged'
  }
  if (existsSync(own) && !readFileSync(own, 'utf8').includes(MARK)) return 'packaged'
  const icon = join(place.dataHome, 'icons', 'hicolor', '256x256', 'apps', 'yogurt.png')
  const text = desktopEntry(quote(place.appImage ?? place.execPath), icon, !place.appImage)
  const iconCurrent = existsSync(icon) && readFileSync(icon).equals(readFileSync(place.icon))
  if (iconCurrent && existsSync(own) && readFileSync(own, 'utf8') === text) return 'current'
  mkdirSync(join(icon, '..'), { recursive: true })
  if (!iconCurrent) copyFileSync(place.icon, icon)
  mkdirSync(join(own, '..'), { recursive: true })
  writeFileSync(own, text)
  return 'written'
}
