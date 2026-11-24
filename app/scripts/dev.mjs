// pnpm dev: electron-vite's dev server and Electron, after the checks that otherwise end in an unclear crash.
// - Electron's own download is there: a skipped postinstall leaves only "Error: Electron uninstall".
// - Linux on Wayland: Electron starts on X11 straight away, like the AppImage's launcher (build/linux-launcher.sh).
//   The app's own relaunch (src/main/display.ts) ends the first Electron, and electron-vite stops the dev server with it.
// - Linux where unprivileged user namespaces are off (Ubuntu 24.04): Electron's chrome-sandbox has to be root's with
//   mode 4755, and the folder can't have a space in its path (Chromium splits the helper's command at spaces).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** the switches Electron starts with: X11 through XWayland on a Wayland desktop, unless a switch was given by hand */
export function electronArgs(platform, env, args) {
  if (platform !== 'linux' || env.YOGURT_FAKE === '1') return args
  if (!env.WAYLAND_DISPLAY || !env.DISPLAY || args.some((a) => a.startsWith('--ozone-platform'))) return args
  return ['--ozone-platform=x11', ...args]
}

/** what stops Chromium's setuid sandbox from starting, each with its fix; empty when it will start */
export function sandboxProblems({ platform, env, usernsRestricted, sandbox, electronDir }) {
  if (platform !== 'linux' || !usernsRestricted || env.ELECTRON_DISABLE_SANDBOX) return []
  const problems = []
  if (sandbox && !(sandbox.uid === 0 && (sandbox.mode & 0o7777) === 0o4755)) {
    const file = join(electronDir, 'dist', 'chrome-sandbox')
    problems.push(`Electron's sandbox helper must be owned by root with mode 4755 (again after each reinstall of node_modules):\n  sudo chown root:root "${file}"\n  sudo chmod 4755 "${file}"`)
  }
  if (electronDir.includes(' ')) problems.push(`Electron's sandbox can't start from a folder with a space in its path:\n  ${electronDir}\nMove the repository to a path without spaces.`)
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = join(dirname(fileURLToPath(import.meta.url)), '..')
  const resolve = createRequire(join(app, 'package.json')).resolve
  const electronDir = dirname(resolve('electron/package.json'))
  const run = (cmd, args) => spawnSync(cmd, args, { cwd: app, stdio: 'inherit' }).status ?? 1

  if (!existsSync(join(electronDir, 'path.txt'))) {
    console.log("Electron's download is missing: fetching it")
    if (run(process.execPath, [join(electronDir, 'install.js')]) !== 0) process.exit(1)
  }

  let usernsRestricted = false
  try { usernsRestricted = readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1' } catch {}
  const sandboxFile = join(electronDir, 'dist', 'chrome-sandbox')
  const sandbox = existsSync(sandboxFile) ? statSync(sandboxFile) : null
  const problems = sandboxProblems({ platform: process.platform, env: process.env, usernsRestricted, sandbox, electronDir })
  if (problems.length) {
    console.error(`${problems.join('\n\n')}\n\nOr skip Electron's sandbox for this run: ELECTRON_DISABLE_SANDBOX=1 pnpm dev`)
    process.exit(1)
  }

  const args = electronArgs(process.platform, process.env, process.argv.slice(2))
  const electronVite = join(dirname(resolve('electron-vite/package.json')), 'bin', 'electron-vite.js')
  process.exit(run(process.execPath, [electronVite, 'dev', ...(args.length ? ['--', ...args] : [])]))
}
