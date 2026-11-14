import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')

async function launch(env: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-diarize-e2e-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...env } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}

/** who heads the turn a line is in (turns are found by their line's words: the who text changes) */
const turnOf = (page: Page, text: string) => page.getByTestId('transcript-turn').filter({ has: page.getByTestId('transcript-line').filter({ hasText: text }) })
const whoOf = (page: Page, text: string) => turnOf(page, text).getByTestId('transcript-who')

/** a recorded, finished meeting with its transcript open; done means the diarization ran (the notes wait for it) */
async function record(page: Page) {
  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
  await page.getByTestId('note-transcript-toggle').click()
  // the fake meeting is heard in real time: both of the other side's lines arrive at 5.2 s and 13.3 s
  await expect(page.getByTestId('transcript-line').filter({ hasText: 'She will send a draft' })).toBeVisible({ timeout: 45_000 })
  await page.getByTestId('note-stop').click()
  await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'done', { timeout: 60_000 })
  // a summary arriving takes the note back to its notes: open the transcript again (harmless when already open)
  await page.getByTestId('note-transcript-toggle').click()
}

test('a recorded meeting splits into two speakers with distinct colours', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_AX: 'denied' }) // no call names: Speaker 1 / Speaker 2
  try {
    await record(page)
    // the fixtures' two them lines are two voices in fake diarization
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Speaker 1', { timeout: 30_000 })
    await expect(whoOf(page, 'She will send a draft')).toHaveText('Speaker 2', { timeout: 30_000 })
    const first = await whoOf(page, 'The site goes live on Tuesday').getAttribute('data-color')
    const second = await whoOf(page, 'She will send a draft').getAttribute('data-color')
    expect(first).not.toBe(second)
  } finally { await app.close() }
})

test('inline rename updates every turn of the voice, keeps its colour, and survives a reload; a taken name asks to merge', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_AX: 'denied' })
  try {
    await record(page)
    const who = whoOf(page, 'The site goes live on Tuesday')
    await expect(who).toHaveText('Speaker 1', { timeout: 30_000 })
    const firstColor = await who.getAttribute('data-color')
    await who.click()
    const input = page.getByTestId('speaker-name-input')
    await input.fill('  Ana   Silva ')
    await input.press('Enter')
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Ana Silva')
    // the other voice is untouched, and the renamed voice keeps its colour slot
    await expect(whoOf(page, 'She will send a draft')).toHaveText('Speaker 2')
    expect(await whoOf(page, 'The site goes live on Tuesday').getAttribute('data-color')).toBe(firstColor)
    // naming the second voice the first one's name asks to merge them, like the menu does
    await whoOf(page, 'She will send a draft').click()
    await page.getByTestId('speaker-name-input').fill('Ana Silva')
    await page.getByTestId('speaker-name-input').press('Enter')
    await expect(page.getByTestId('speaker-merge-confirm')).toContainText('Ana Silva')
    await page.getByTestId('speaker-merge-confirm').click()
    await expect(whoOf(page, 'She will send a draft')).toHaveText('Ana Silva')
    // a reload keeps the name on both voices
    await page.reload()
    await page.getByTestId('note-transcript-toggle').click()
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Ana Silva')
    await expect(whoOf(page, 'She will send a draft')).toHaveText('Ana Silva')
  } finally { await app.close() }
})

test('merge combines two voices and keeps the first speaker\u2019s colours', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_AX: 'denied' })
  try {
    await record(page)
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Speaker 1', { timeout: 30_000 })
    await whoOf(page, 'The site goes live on Tuesday').click()
    await page.getByTestId('speaker-name-input').fill('Ana')
    await page.getByTestId('speaker-name-input').press('Enter')
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Ana')
    const second = whoOf(page, 'She will send a draft')
    await expect(second).toHaveText('Speaker 2')
    const secondColorBefore = await second.getAttribute('data-color')
    await second.click()
    await page.getByTestId('speaker-name-input').fill('Bo')
    await page.getByTestId('speaker-name-input').press('Enter')
    await expect(second).toHaveText('Bo')
    // the second voice's menu offers the first one to merge into, asks once, then applies
    await turnOf(page, 'She will send a draft').getByTestId('speaker-menu').click()
    await page.getByRole('menuitem', { name: 'Merge into Ana' }).click()
    await page.getByTestId('speaker-merge-confirm').click()
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Ana', { timeout: 15_000 })
    await expect(whoOf(page, 'She will send a draft')).toHaveText('Ana')
    // Ana keeps the first slot; the merged voice's lines join it without reshuffling
    const anaColor = await whoOf(page, 'The site goes live on Tuesday').getAttribute('data-color')
    expect(anaColor).toBe('0')
    expect(await whoOf(page, 'She will send a draft').getAttribute('data-color')).toBe(anaColor)
    expect(secondColorBefore).not.toBe(anaColor)
  } finally { await app.close() }
})

test('diarization failure leaves the transcript usable', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_AX: 'denied', YOGURT_FAKE_DIARIZE_FAIL: '1' })
  try {
    await record(page)
    await expect(page.getByTestId('transcript-line').filter({ hasText: 'The site goes live' })).toBeVisible({ timeout: 30_000 })
    // no names arrived, nothing crashed: the lines stay Them, with no speaker numbers invented
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Them')
    await expect(whoOf(page, 'She will send a draft')).toHaveText('Them')
    await expect(page.getByTestId('transcript')).not.toContainText(/Speaker \d/)
  } finally { await app.close() }
})
