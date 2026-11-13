import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'

let cached: string | undefined
/** The full name of the person using this Mac (Daniel Brooks), not the short one (daniel); cached. Elsewhere the login name. */
export function macFullName(platform: string = process.platform): string {
  if (cached) return cached
  // id -F is the Mac's own: elsewhere it only prints an error
  if (platform === 'darwin') try { cached = execFileSync('id', ['-F'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { cached = '' }
  return (cached ||= userInfo().username)
}
