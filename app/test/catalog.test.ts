import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as catalog from '../src/main/catalog'
import bundled from '../../catalog/catalog.json'
import licenses from '../../catalog/licenses.json'

describe('the catalog', () => {
  it('is the one in this build: nothing is fetched at launch (new models come with app updates)', () => {
    expect(Object.keys(catalog).sort()).toEqual(['loadCatalog'])
    const cat = catalog.loadCatalog({ bundled, licenses })
    expect(cat.models).toHaveLength(bundled.models.length)
    expect(cat.asr.length).toBeGreaterThan(0)
  })
  it('a broken bundled catalog is a clear error', () => {
    expect(() => catalog.loadCatalog({ bundled: { version: 1, models: [] }, licenses })).toThrow(/Bundled catalog is invalid/)
  })
  it('the speaker model pin is the file the release serves today', () => {
    // measured with curl on Linux and on an Apple-silicon Mac on 2026-11-26; the asset is 1 byte bigger than the
    // hash this branch first pinned, so a fresh install fails the sha check and voice profiles never work
    const s = bundled.speaker as { sha256: string; bytes: number }
    expect(s.sha256).toBe('53cab20ba8f2eb2f6e2d89ecc18e88ef3222169b61b4419cbc13666744a4574b')
    expect(s.bytes).toBe(28281165)
  })
})

/** every file under a folder */
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]))

describe('nothing leaves the Mac', () => {
  it('only model downloads (pinned URLs) and whisper-server on 127.0.0.1 make requests; the update check is electron-updater', () => {
    const src = join(__dirname, '../src')
    // files allowed to make requests: model downloads from the catalog's pinned URLs, whisper-server on 127.0.0.1
    // and the person's own calendar link (Windows and Linux), straight from this computer to their calendar provider
    const allowed = new Set(['main/downloader.ts', 'main/asr/server.ts', 'main/asr/transcribe.ts', 'main/calendarLink/get.ts'])
    const calls = files(src).filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => /(?<![.\w]|async )fetch\(|(\?\?|=) fetch\b|net\.request|from 'node:https?'|require\('https?'\)|new WebSocket|XMLHttpRequest|raw\.githubusercontent/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(src.length + 1).replaceAll('\\', '/'))
      // the home list pages through its own IPC call named fetch
      .filter((f) => f !== 'renderer/src/paging.ts')
    expect(calls.filter((f) => !allowed.has(f))).toEqual([])
  })
})
