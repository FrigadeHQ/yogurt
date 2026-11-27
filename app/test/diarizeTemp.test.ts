import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DIARIZE_TMP_PREFIX, sweepDiarizeTemp } from '../src/main/diarize/temp'

const made: string[] = []
afterEach(() => { for (const d of made.splice(0)) { try { sweepDiarizeTemp(d) } catch { /* best effort */ } } })

it('sweeps a crashed run\'s temp dir and nothing else in tmpdir', () => {
  // profiles and test data share tmpdir and some of their names start like the runs' own. A sweep widenet
  // enough to catch them deletes a person's settings.json with the leftover wav (it did: yogurt-diarize-e2e-…).
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-sweep-test-'))
  made.push(dir)
  const run = join(dir, `${DIARIZE_TMP_PREFIX}abc123`), e2e = join(dir, 'yogurt-diarize-e2e-abc123')
  for (const d of [run, e2e]) {
    mkdirSync(d)
    writeFileSync(join(d, 'them.wav'), 'x')
  }
  writeFileSync(join(e2e, 'settings.json'), JSON.stringify({ speakerDiarization: true }))
  expect(sweepDiarizeTemp(dir)).toEqual([`${DIARIZE_TMP_PREFIX}abc123`])
  expect(existsSync(run)).toBe(false)
  expect(existsSync(join(e2e, 'settings.json'))).toBe(true)
})

it('a tmpdir it cannot read never takes the app down', () => {
  expect(sweepDiarizeTemp(join(tmpdir(), 'yogurt-sweep-missing-', 'nope'))).toEqual([])
})
