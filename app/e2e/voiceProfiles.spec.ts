import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')

/** dir can be passed again so a later app reads the same data: that is how a stored profile matches across meetings */
async function launch(env: Record<string, string> = {}, dir = mkdtempSync(join(tmpdir(), 'yogurt-voices-e2e-'))) {
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: dir, ...env } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page, dir }
}

/** who heads the turn a line is in (turns are found by their line's words: the who text changes) */
const whoOf = (page: Page, text: string) => page.getByTestId('transcript-turn').filter({ has: page.getByTestId('transcript-line').filter({ hasText: text }) }).getByTestId('transcript-who')
const profilesOf = (page: Page) => page.evaluate(() => window.yogurt.voices.list())

async function settings(page: Page) {
  await page.getByTestId('settings-open').click()
  await expect(page.getByTestId('voice-recognition')).toBeVisible()
}

/** a recorded meeting stopped once both of the other side's lines were heard; done means its diarization ran (the notes wait for it) */
async function recordOnce(page: Page) {
  await page.getByTestId('nav-home').click()
  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
  await page.getByTestId('note-transcript-toggle').click()
  await expect(page.getByTestId('transcript-line').filter({ hasText: 'She will send a draft' })).toBeVisible({ timeout: 45_000 })
  await page.getByTestId('note-stop').click()
  await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'done', { timeout: 60_000 })
}

test('opt-in: the first meeting enrolls the named voice, the next matches it; an ambiguous match stays Speaker N', async () => {
  test.setTimeout(240_000) // three fake meetings, each real-time to the fixtures' second them line
  const { app, page, dir } = await launch()
  try {
    await settings(page)
    await page.getByTestId('voice-toggle').click()
    await expect(page.getByTestId('voice-consent')).toBeVisible() // a voiceprint is biometric: asked once
    await page.getByTestId('voice-consent-accept').click()
    await expect(page.getByTestId('voice-toggle')).toHaveAttribute('aria-checked', 'true')
    // meeting 1: Ann Lee claims 3.5 s of the first voice (enrolled); Bo Park's claim is 1.5 s, under the 2 s bar,
    // so that voice stays Speaker 1 and is never enrolled
    await recordOnce(page)
    await expect.poll(() => profilesOf(page), { timeout: 30_000 }).toEqual([expect.objectContaining({ name: 'Ann Lee', meetings: 1 })])
    await settings(page)
    await expect(page.getByTestId('voice-profile')).toHaveCount(1)
    await expect(page.getByTestId('voice-profile')).toContainText('Ann Lee')
    // meeting 2: the first voice is named again and its profile now counts two meetings
    await recordOnce(page)
    await page.getByTestId('note-transcript-toggle').click()
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Ann Lee', { timeout: 30_000 })
    await expect(whoOf(page, 'She will send a draft')).toHaveText('Speaker 1', { timeout: 30_000 })
    await expect.poll(() => profilesOf(page)).toEqual([expect.objectContaining({ name: 'Ann Lee', meetings: 2 })])
    await settings(page)
    await expect(page.getByTestId('voice-profile')).toContainText('2 meetings')
    // meeting 3, a fresh app on the same data: the voice only matches ambiguously (0.62, under the 0.72 naming
    // bar) and no call name marks it, so it stays Speaker N and the profile is left alone
    await app.close()
    const { app: app2, page: page2 } = await launch({ YOGURT_FAKE_AX: 'denied', YOGURT_FAKE_VOICE_SIM: 'ambiguous' }, dir)
    try {
      await recordOnce(page2)
      await page2.getByTestId('note-transcript-toggle').click()
      await expect(whoOf(page2, 'The site goes live on Tuesday')).toHaveText('Speaker 1', { timeout: 30_000 })
      await expect(whoOf(page2, 'She will send a draft')).toHaveText('Speaker 2', { timeout: 30_000 })
      await expect.poll(() => profilesOf(page2)).toEqual([expect.objectContaining({ name: 'Ann Lee', meetings: 2 })])
    } finally { await app2.close() }
  } finally { await app.close().catch(() => {}) }
})

test('opt-out records no profiles; off keeps them; delete and delete-all remove them', async () => {
  test.setTimeout(240_000) // three fake meetings
  const { app, page } = await launch()
  try {
    await settings(page)
    await page.getByTestId('voice-toggle').click()
    await page.getByTestId('voice-consent-accept').click()
    // meeting 1 (on): Ann Lee is enrolled
    await recordOnce(page)
    await expect.poll(() => profilesOf(page), { timeout: 30_000 }).toHaveLength(1)
    await settings(page)
    await expect(page.getByTestId('voice-profile')).toHaveCount(1)
    // off, but kept: the profiles stay, unused, and a note says so
    await page.getByTestId('voice-toggle').click()
    await expect(page.getByTestId('voice-toggle')).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByTestId('voice-off-note')).toBeVisible()
    // meeting 2 (off): heard and diarized, but no profile is enrolled or bumped
    await recordOnce(page)
    await settings(page)
    await expect(page.getByTestId('voice-off-note')).toBeVisible()
    await expect.poll(() => profilesOf(page), { timeout: 15_000 }).toEqual([expect.objectContaining({ name: 'Ann Lee', meetings: 1 })])
    // back on: the consent is remembered, the row returns unchanged
    await page.getByTestId('voice-toggle').click()
    await expect(page.getByTestId('voice-consent')).toHaveCount(0)
    await expect(page.getByTestId('voice-profile')).toContainText('Ann Lee')
    await expect(page.getByTestId('voice-profile')).toContainText('1 meeting')
    // delete the one profile; with none left the delete-all action is gone too
    await page.getByTestId('voice-delete').first().click()
    await expect(page.getByTestId('voice-empty')).toBeVisible()
    await expect(page.getByTestId('voice-delete-all')).toHaveCount(0)
    // meeting 3 (on) enrolls again; Delete all asks first, then empties the list
    await recordOnce(page)
    await settings(page)
    await expect(page.getByTestId('voice-profile')).toHaveCount(1)
    await page.getByTestId('voice-delete-all').click()
    await expect(page.getByTestId('voice-delete-confirm')).toBeVisible()
    await page.getByTestId('voice-delete-all-yes').click()
    await expect(page.getByTestId('voice-empty')).toBeVisible()
    await expect(page.getByTestId('voice-delete-all')).toHaveCount(0)
    await expect(profilesOf(page)).resolves.toHaveLength(0)
  } finally { await app.close() }
})
