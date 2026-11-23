/** Why this Yogurt is running, so a log says what opened it and an AI app's start can stay out of the way (#147) */
export type StartReason = 'login' | 'ai-app' | 'update' | 'user'

/** what yogurt-mcp passes, next to --hidden, when an AI app starts Yogurt */
export const AI_APP_ARG = '--started-by=ai-app'

/**
 * argv: Yogurt's own. env: YOGURT_STARTED_BY=ai-app also counts. parent: the program that started it, where the
 * computer says cheaply (Linux), so an older yogurt-mcp that passed only --hidden is still known.
 * --hidden alone is the login item (Windows, Linux); a Mac says so itself (openedAtLogin). --updated is the installer.
 */
export function startReason(o: { argv: string[]; env: Record<string, string | undefined>; parent?: string; openedAtLogin?: boolean }): StartReason {
  if (o.argv.includes(AI_APP_ARG) || o.env.YOGURT_STARTED_BY === 'ai-app') return 'ai-app'
  if (o.argv.includes('--hidden') && /^yogurt-mcp(\.exe)?$/i.test(o.parent ?? '')) return 'ai-app'
  if (o.openedAtLogin || o.argv.includes('--hidden')) return 'login'
  if (o.argv.includes('--updated')) return 'update'
  return 'user'
}

/** the switches Yogurt was started with, for the log: names only, so no folder or file name lands there */
export function startArgs(argv: string[]): string {
  const flags = argv.slice(1).filter((a) => a.startsWith('--')).map((a) => (/[\\/:]/.test(a) ? a.split('=')[0] : a))
  return flags.length ? flags.join(' ') : 'none'
}
