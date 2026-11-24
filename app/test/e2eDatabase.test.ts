import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// End-to-end tests open the app's own database next to the running app. Without a busy timeout a test's write fails
// at once with "database is locked" whenever the app happens to be writing, which flaked CI (autosave.spec.ts).
describe('end-to-end tests open the app database patiently', () => {
  it('every connection to a running app\'s yogurt.db has a busy timeout', () => {
    const dir = join(__dirname, '../e2e')
    const bare = readdirSync(dir).filter((f) => f.endsWith('.ts'))
      .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').map((l, i) => ({ f, i, l })))
      .filter(({ l }) => /new DatabaseSync\(join\(userData, 'yogurt\.db'\)\)/.test(l))
      .map(({ f, i }) => `${f}:${i + 1}`)
    expect(bare).toEqual([])
  })
})
