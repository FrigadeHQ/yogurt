import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { loadSettings, updateSettings } from '../settings'

/** an AI app added in Settings → AI apps: the name the person gave it, never its key */
export type AiApp = { id: string; name: string }
type Stored = AiApp & { token: string }

/** what a key looks like: what the helpers check before sending one */
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,200}$/

const digest = (s: string) => createHash('sha256').update(s).digest()

/**
 * The AI apps the person added, each with its own key (YOGURT_MCP_TOKEN for yogurt-mcp). Keys are kept in
 * settings.json sealed with the system keychain, like calendar links, and compared without leaking timing.
 */
export function createAiApps(d: {
  file: string
  seal: (plain: string) => string
  open: (sealed: string) => string
}) {
  const stored = (): Stored[] => loadSettings(d.file).aiAppTokens ?? []
  const tokenOf = (a: Stored) => { try { return d.open(a.token) } catch { return null } }
  return {
    list: (): AiApp[] => stored().map(({ id, name }) => ({ id, name })),
    /** a new app and its key; null when the name is empty */
    add(name: string): { app: AiApp; token: string } | null {
      const label = name.trim().slice(0, 60)
      if (!label) return null
      const app = { id: randomUUID(), name: label }
      const token = `yog_${randomBytes(32).toString('base64url')}`
      updateSettings(d.file, { aiAppTokens: [...stored(), { ...app, token: d.seal(token) }] })
      return { app, token }
    },
    /** the key of an app already added, to copy its setup again */
    token: (id: string): string | null => { const a = stored().find((x) => x.id === id); return a ? tokenOf(a) : null },
    remove(id: string): boolean {
      const all = stored()
      if (!all.some((a) => a.id === id)) return false
      const rest = all.filter((a) => a.id !== id)
      updateSettings(d.file, { aiAppTokens: rest.length ? rest : undefined })
      return true
    },
    /** the app this key belongs to, if any */
    check(token: string): AiApp | undefined {
      if (!TOKEN_SHAPE.test(token)) return undefined
      const given = digest(token)
      let found: AiApp | undefined
      // every app is compared, so how long this takes doesn't say which one matched
      for (const a of stored()) {
        const t = tokenOf(a)
        if (t && timingSafeEqual(digest(t), given) && !found) found = { id: a.id, name: a.name }
      }
      return found
    },
  }
}
export type AiApps = ReturnType<typeof createAiApps>
