import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

// Plans, specs and agent notes are for working on Yogurt, not for the public repo.
const notAllowed = [
  /(^|\/)docs\/superpowers\//i,
  /(^|\/)(plans?|specs?)\/[^/]+\.md$/i,
  /-(plan|design|spec)\.md$/i,
  /(^|\/)(AGENTS|CLAUDE)\.md$/i,
]

export function planDocs(paths: string[]): string[] {
  return paths.filter((p) => notAllowed.some((re) => re.test(p)))
}

describe('no plan documents in the repo', () => {
  it('spots plans, specs and agent notes', () => {
    expect(planDocs([
      'docs/superpowers/specs/2026-11-20-ios-companion-design.md',
      'docs/superpowers/plans/2026-11-20-ios-companion.md',
      'docs/plans/launch.md',
      'notes/calendar-design.md',
      'AGENTS.md',
      'app/CLAUDE.md',
    ])).toHaveLength(6)
  })

  it('leaves normal docs and test files alone', () => {
    expect(planDocs([
      'README.md',
      'docs/connect-ai-apps.md',
      'app/e2e/speakerColors.spec.ts',
      'app/src/shared/specs.ts',
      'site/app/privacy.md',
    ])).toEqual([])
  })

  it('finds none in the files git tracks', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: `${__dirname}/../..`, encoding: 'utf8' }).split('\n').filter(Boolean)
    expect(planDocs(tracked)).toEqual([])
  })
})
