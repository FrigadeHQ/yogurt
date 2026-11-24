import type { StartReason } from './startReason'

/** how long a Yogurt an AI app started stays once no AI app is connected */
export const QUIT_AFTER_MS = 2 * 60_000

/**
 * A Yogurt an AI app started (yogurt-mcp, while Yogurt was closed) only serves that app: no window, no call watching,
 * so no "Take notes?" for a call the person never asked about (#147: Discord, always on the mic, popped up minutes
 * after every quit). The person opening Yogurt (window, tray, Dock) makes it a normal Yogurt from then on.
 * Until then it quits by itself once no AI app has been connected for QUIT_AFTER_MS, so a quit Yogurt doesn't stay
 * behind in the tray after the AI app is gone. Work in progress (a download, notes being written) is waited for.
 */
export function createQuietStart(o: { reason: StartReason; quit(): void; busy(): boolean }) {
  let quiet = o.reason === 'ai-app'
  let connected = 0
  let timer: NodeJS.Timeout | undefined
  const stop = () => { clearTimeout(timer); timer = undefined }
  const arm = () => {
    stop()
    if (!quiet || connected > 0) return
    timer = setTimeout(() => {
      timer = undefined
      if (!quiet || connected > 0) return
      if (o.busy()) { arm(); return }
      console.info('APP no AI app connected to the Yogurt one started: quitting')
      o.quit()
    }, QUIT_AFTER_MS)
    timer.unref?.()
  }
  const normal = () => { if (quiet) { quiet = false; stop(); console.info('APP opened by the person: watching for calls') } }
  arm()
  return {
    quiet: () => quiet,
    /** a window at start: not for a login or an AI app's start */
    window: () => o.reason === 'user' || o.reason === 'update',
    /** one round of call watching, skipped while quiet */
    detect: async (tick: () => Promise<unknown>) => { if (!quiet) await tick() },
    /** the person opened Yogurt */
    opened: normal,
    /** Yogurt was started again while running (second-instance): a login start makes it normal too */
    startedAgain: (reason: StartReason) => { if (reason === 'login') normal() },
    /** how many AI apps are connected now */
    clients: (n: number) => { connected = n; arm() },
  }
}
