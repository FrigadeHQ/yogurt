import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadSettings, updateSettings } from '../settings'
import { checkServer, cleanUrl, type NotesServer, type NotesServerCheck, type NotesServerView } from './remote'

/** what Settings may change; key: a new one (saved to its own file), '' removes it, missing leaves it */
export type NotesServerPatch = { enabled?: boolean; url?: string; model?: string; key?: string }

const MAX = 500

/**
 * Settings → Notes server, without Electron so it can be tested: the address, model and switch live in settings.json;
 * the key lives in notes-server.key in the profile folder (only this user can read it) and never goes back to the window.
 */
export function notesServerSettings(o: { settingsFile: string; profile: string; check?: typeof checkServer }) {
  const keyPath = join(o.profile, 'notes-server.key')
  const current = (): NotesServer | undefined => loadSettings(o.settingsFile).notesServer
  const keyFileOf = (s?: NotesServer) => s?.keyFile ?? keyPath
  const savedKey = () => {
    try { return readFileSync(keyFileOf(current()), 'utf8').trim() || undefined } catch { return undefined }
  }
  const view = (): NotesServerView => {
    const s = current()
    return { enabled: !!s && s.enabled !== false && !!s.url && !!s.model, url: s?.url ?? '', model: s?.model ?? '', hasKey: !!savedKey() }
  }

  return {
    view,
    /** saves what changed and says what is saved now; an address that isn't http(s) is refused, nothing saved */
    set(patch: NotesServerPatch): NotesServerView {
      const s = current()
      const next: NotesServer = { ...s, url: s?.url ?? '', model: s?.model ?? '' }
      if (typeof patch.url === 'string') {
        const url = patch.url.trim() ? cleanUrl(patch.url.slice(0, MAX)) : ''
        if (url === undefined) throw new Error('not an http or https address')
        next.url = url
      }
      if (typeof patch.model === 'string') next.model = patch.model.trim().slice(0, MAX)
      if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
      if (typeof patch.key === 'string') {
        const key = patch.key.trim().slice(0, MAX)
        if (key) {
          writeFileSync(keyPath, key + '\n', { mode: 0o600 })
          next.keyFile = keyPath
        } else {
          if (existsSync(keyPath)) rmSync(keyPath)
          delete next.keyFile
        }
      }
      updateSettings(o.settingsFile, { notesServer: next })
      return view()
    },
    /** Test: the key being typed, or the saved one */
    check(url: string, key?: string): Promise<NotesServerCheck> {
      return (o.check ?? checkServer)(url, key?.trim() || savedKey())
    },
  }
}
