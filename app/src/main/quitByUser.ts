import { app } from 'electron'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StartReason } from './startReason'

/**
 * #147: the person quitting Yogurt (the menu bar's Quit, the app menu, Cmd+Q, Ctrl+Q) leaves this file in the profile,
 * and yogurt-mcp doesn't start Yogurt for an AI app while it's there. Any other quit (an update, logout, a crash, a
 * quiet Yogurt quitting by itself) leaves none, so an AI app can still start it then. The person opening Yogurt again
 * (or a login or update start) removes it.
 */
export const QUIT_MARKER = 'quit-by-user'
/** what yogurt-mcp tells the AI app instead (both helpers have the same words) */
export const CLOSED = 'Yogurt is closed. Open Yogurt to use your meetings.'

let asked = false
let quitFromMenu = () => app.quit()

/** A native Dock quit goes straight to before-quit. Tag JS app.quit() calls while they synchronously
 * emit that event, so internal quits can always pass, including while a person is deciding. */
export function recordingQuitGuard(activeId: () => string | undefined, confirm: (signal: AbortSignal) => Promise<boolean>, os = process.platform) {
  const quit = app.quit.bind(app)
  let byUser = os === 'darwin'
  const requestQuit = (user: boolean) => {
    const previous = byUser
    byUser = user
    try { quit() } finally { byUser = previous }
  }
  quitFromMenu = () => requestQuit(true)
  app.quit = () => requestQuit(false)

  let pending: AbortController | undefined
  return (sessionEnding: boolean): boolean => {
    const id = activeId()
    if (!id || !byUser || sessionEnding) {
      if (pending) {
        pending.abort()
        pending = undefined
        quitCalledOff()
      }
      return false
    }
    if (!pending) {
      const prompt = new AbortController()
      pending = prompt
      void confirm(prompt.signal).catch(error => {
        console.error('Could not confirm quitting during recording', error)
        return false
      }).then(confirmed => {
        if (prompt.signal.aborted) return
        pending = undefined
        const current = activeId()
        if (confirmed && (!current || current === id)) app.quit()
        else quitCalledOff()
      })
    }
    return true
  }
}

/** the person chose Quit */
export function quitByUser() { asked = true; quitFromMenu() }
/** the quit was called off (unsaved notes: Return to notes), so a later quit is not the person's unless they ask again */
export function quitCalledOff() { asked = false }
/** tests */
export function resetQuitByUser() { asked = false }

/** Yogurt is quitting now: marked only when the person asked */
export function quitting(dir: string) {
  if (!asked) return
  try { writeFileSync(join(dir, QUIT_MARKER), '') } catch (e) { console.error('APP could not note the quit', e) }
}

/**
 * At start: any start but an AI app's clears the mark. True: an AI app started Yogurt after the person quit it
 * (a yogurt-mcp from before the mark), so this Yogurt stops at once.
 */
export function started(dir: string, reason: StartReason): boolean {
  const file = join(dir, QUIT_MARKER)
  if (reason === 'ai-app') return existsSync(file)
  try { rmSync(file, { force: true }) } catch (e) { console.error('APP could not clear the quit', e) }
  return false
}
