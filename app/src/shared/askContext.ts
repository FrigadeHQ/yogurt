export type ContextChip = { kind: 'meeting' | 'folder'; id: string }
export type ContextTarget = ContextChip & { title: string; startedAt?: number }
/** Sent scope is retained; only new draft attachments are appended, in selection order. */
export function attachContext<T extends ContextChip>(scope: T[], draft: T[]): T[] {
  const seen = new Set<string>()
  return [...scope, ...draft].filter(c => {
    const key = `${c.kind}:${c.id}`
    if (seen.has(key)) return false
    seen.add(key); return true
  })
}
export function contextKey(chips: ContextChip[]): string { return JSON.stringify(chips.map(c => `${c.kind}:${c.id}`).sort()) }
export function chipScope(chips: ContextChip[], meeting: (id: string) => boolean, folder: (id: string) => string[]): string[] | undefined {
  if (!chips.length) return undefined
  return [...new Set(chips.flatMap(c => c.kind === 'meeting' ? meeting(c.id) ? [c.id] : [] : folder(c.id).filter(meeting)))]
}
type AskDestination = { kind: 'focus' } | { kind: 'panel' } | { kind: 'conversation'; chips: ContextChip[] }
export function askDestination(route: string): AskDestination {
  if (route === '/chat' || route.startsWith('/chat/')) return { kind: 'focus' }
  if (route.startsWith('/note/')) return { kind: 'panel' }
  if (route.startsWith('/folder/')) return { kind: 'conversation', chips: [{ kind: 'folder', id: route.slice(8) }] }
  return { kind: 'conversation', chips: [] }
}

/** Dialogs that give way to ⌘J: looking up the shortcut, or searching for it, shouldn't stop it working (#175). */
const giveWay = new Set(['shortcuts-dialog', 'search'])
/** What ⌘J does over the open dialogs (by test id; Ask's own panel left out): a question or form the person is answering keeps it. */
export function askOverDialogs(dialogs: (string | undefined)[]): 'ask' | 'dismiss' | 'blocked' {
  const open = dialogs.filter(d => d !== 'chat-panel')
  if (open.some(d => !d || !giveWay.has(d))) return 'blocked'
  return open.length ? 'dismiss' : 'ask'
}

export function mentionAt(value: string, caret: number): { start: number; end: number; query: string } | undefined {
  const match = /(?:^|\s)@([^@\n]{0,80})$/.exec(value.slice(0, caret))
  return match ? { start: caret - match[1].length - 1, end: caret, query: match[1] } : undefined
}
