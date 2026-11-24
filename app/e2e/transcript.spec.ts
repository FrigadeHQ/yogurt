import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
const zoom = { bundleId: 'us.zoom.xos', name: 'zoom.us' }

async function launch(env: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...env } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page, userData }
}
const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>
const windowOf = async (app: ElectronApplication, hash: string): Promise<Page> => {
  for (let i = 0; i < 100; i++) {
    const w = app.windows().find((p) => p.url().includes(hash))
    if (w) return w
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`no ${hash} window`)
}

/** who heads the turn a line is in */
const whoOf = (page: Page, text: string) => page.getByTestId('transcript-turn').filter({ has: page.getByTestId('transcript-line').filter({ hasText: text }) }).getByTestId('transcript-who')

test('live, each turn says who: You on the mic, and the name the call app shows talking on the other side', async () => {
  const { app, page } = await launch()
  try {
    await fake(app, 'signals', { micApps: [zoom], events: [] })
    await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    // the fixtures' first phrases: me at 0.5 s, them at 5.2 s (each line shows after the pause that ends it); the fake Zoom marks Ann Lee then
    const lines = page.getByTestId('transcript-line')
    const mine = lines.filter({ hasText: 'Can we go over the launch plan' }), theirs = lines.filter({ hasText: 'The site goes live on Tuesday' })
    await expect(mine).toHaveText(/^Hi, thanks for joining/, { timeout: 30_000 })
    await expect(theirs).toHaveText(/^Sure\./, { timeout: 30_000 })
    await expect(theirs).toHaveAttribute('data-track', 'them')
    await expect(whoOf(page, 'Can we go over the launch plan')).toHaveText('You')
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Ann Lee')
    // Bo Park is marked for the second line
    await expect(whoOf(page, 'She will send a draft')).toHaveText('Bo Park', { timeout: 40_000 })
    // the same after the meeting
    await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('note-summary-tab')).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', /^(stopped|done)$/)
    await expect(whoOf(page, 'Can we go over the launch plan')).toHaveText('You', { timeout: 15_000 })
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Ann Lee')
    await expect(whoOf(page, 'She will send a draft')).toHaveText('Bo Park')
    // everyone seen in the call is at the meeting now, the person using Yogurt left out
    const id = (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
    await expect.poll(async () => (await page.evaluate((i) => window.yogurt.meetings.get(i), id))?.attendees.map((a) => a.name)).toEqual(['Ann Lee', 'Bo Park', 'Cy Dao'])
  } finally { await app.close() }
})

test('while someone talks, a quick lighter reading shows first; the final line replaces it', async () => {
  const { app, page } = await launch()
  try {
    await fake(app, 'signals', { micApps: [zoom], events: [] })
    await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const partial = page.getByTestId('transcript-partial')
    // the first sentence runs a few seconds: its first words show well before it is over
    await expect(partial.first()).toBeVisible({ timeout: 15_000 })
    await expect(partial.first()).toContainText(/^Hi, thanks/)
    expect(await page.getByTestId('transcript-line').count()).toBe(0)
    const lines = page.getByTestId('transcript-line')
    await expect(lines.filter({ hasText: 'Can we go over the launch plan' })).toBeVisible({ timeout: 30_000 })
    await expect(partial.filter({ hasText: 'Hi, thanks' })).toHaveCount(0)
    // it took the reading's place: no fade-in from nothing
    await expect(lines.filter({ hasText: 'Can we go over the launch plan' })).not.toHaveClass(/line-in/)
  } finally { await app.close() }
})

test("with Apple's on-device speech (macOS 26), its words show as they are said and the final line replaces them", async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_FAKE_SPEECH: '1', YOGURT_USER_DATA: userData } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await fake(app, 'signals', { micApps: [zoom], events: [] })
    await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const partial = page.getByTestId('transcript-partial')
    // Apple's first reading comes 0.7 s into the sentence, well before whisper's line (which ends it)
    await expect(partial.filter({ hasText: 'Hi, thanks for' })).toBeVisible({ timeout: 10_000 })
    await expect(partial.first()).toHaveAttribute('data-track', 'me')
    expect(await page.getByTestId('transcript-line').count()).toBe(0)
    await expect(page.getByTestId('transcript-line').filter({ hasText: 'Can we go over the launch plan' })).toBeVisible({ timeout: 30_000 })
    await expect(partial.filter({ hasText: 'Hi, thanks' })).toHaveCount(0)
  } finally { await app.close() }
})

test('opening the note mid-meeting shows the lines already heard', async () => {
  const { app, page } = await launch()
  try {
    await fake(app, 'signals', { micApps: [zoom], events: [] })
    await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await expect(page.getByTestId('transcript-line').first()).toBeVisible({ timeout: 30_000 })
    // a reload loses what the page heard; the note asks the app for the saved lines again
    await page.reload()
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await expect(page.getByTestId('transcript-line').first()).toBeVisible()
  } finally { await app.close() }
})

test('Transcript is a primary page: Escape keeps it open and Notes switches away', async () => {
  const { app, page } = await launch()
  try {
    const id = await fake<string>(app, 'bigMeeting', 20)
    await fake(app, 'go', `/note/${id}`)
    const transcript = page.getByRole('tab', { name: 'Transcript', exact: true })
    const notes = page.getByRole('tab', { name: 'My notes', exact: true })
    await transcript.click()
    await expect(transcript).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('transcript-panel')).toBeVisible()
    await expect(page.getByTestId('transcript-close')).toHaveCount(0)
    const search = page.getByTestId('transcript-search'), trigger = page.getByTestId('transcript-find-open')
    await expect(trigger).toBeVisible()
    await page.keyboard.press('ControlOrMeta+f')
    await expect(search).toBeFocused()
    const lines = page.getByTestId('transcript-line'), before = await lines.count()
    await search.fill('unlikely phrase with no matches')
    await expect(page.getByTestId('transcript-find-count')).toHaveText('No matches')
    await expect(page.getByTestId('transcript-find-next')).toBeDisabled()
    await expect(lines).toHaveCount(before)
    await transcript.click()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await search.fill('')
    await transcript.click()
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await trigger.click()
    await search.fill('unlikely phrase with no matches')
    await page.keyboard.press('Escape')
    await expect(search).toHaveValue('')
    await expect(trigger).toBeFocused()
    await expect(page.getByTestId('transcript-panel')).toBeVisible()
    await expect(transcript).toHaveAttribute('aria-selected', 'true')
    await notes.click()
    await expect(notes).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('transcript-panel')).toBeHidden()
  } finally { await app.close() }
})

test('transcription trouble shows in the widget in plain words', async () => {
  const { app, page } = await launch({ YOGURT_BACKGROUND: '1' })
  try {
    await fake(app, 'signals', { micApps: [zoom], events: [] })
    await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await fake(app, 'warn', 'falling-behind')
    // the recorder shows a warning sign; the words are inside the expanded recorder
    const w = await windowOf(app, '#widget')
    await expect(w.getByTestId('widget-note')).toHaveText('Yogurt is falling behind. Some lines may be missing.')
    await fake(app, 'warn', 'transcribe-failed')
    await expect(w.getByTestId('widget-note')).toHaveText('Some lines are missing for now. Yogurt will fill them in from the recording after the meeting.')
  } finally { await app.close() }
})

test('without Accessibility the other side is Them, live and after; nothing is guessed', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_AX: 'denied' })
  try {
    await fake(app, 'signals', { micApps: [zoom], events: [] })
    await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    const lines = page.getByTestId('transcript-line')
    await expect(lines.filter({ hasText: 'The site goes live on Tuesday' })).toBeVisible({ timeout: 30_000 })
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Them')
    await expect(lines.filter({ hasText: 'She will send a draft' })).toBeVisible({ timeout: 40_000 })
    await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('note-summary-tab')).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', /^(stopped|done)$/)
    // both lines of the other side are one Them turn
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Them')
    await expect(page.getByTestId('transcript')).not.toContainText(/Ann Lee|Bo Park|Speaker/)
  } finally { await app.close() }
})

const startMeeting = async (app: ElectronApplication, page: Page) => {
  await fake(app, 'signals', { micApps: [zoom], events: [] })
  await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
  await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
}
const audioOf = (page: Page) => page.locator('[data-testid^="player-audio-"]')
const audioState = (page: Page) => audioOf(page).evaluateAll((els) => (els as HTMLAudioElement[]).map((a) => ({ track: a.dataset.track, time: a.currentTime, paused: a.paused, rate: a.playbackRate })))

test('each line shows when it was said, from the start of the meeting; no player while recording', async () => {
  const { app, page } = await launch()
  try {
    await startMeeting(app, page)
    const lines = page.getByTestId('transcript-line')
    await expect(lines.filter({ hasText: 'Can we go over the launch plan' }).getByTestId('transcript-time')).toHaveText('0:00', { timeout: 30_000 })
    await expect(lines.filter({ hasText: 'The site goes live on Tuesday' }).getByTestId('transcript-time')).toHaveText('0:05', { timeout: 30_000 })
    await expect(page.getByTestId('player')).toHaveCount(0)
  } finally { await app.close() }
})

test('a read-only transcript plays only from its time buttons', async () => {
  const { app, page, userData } = await launch()
  try {
    const id = await fake<string>(app, 'bigMeeting', 20)
    const db = new DatabaseSync(join(userData, 'yogurt.db'), { timeout: 5000 })
    try {
      db.prepare("UPDATE meetings SET transcription_pending=1, transcription_state='stopped' WHERE id=?").run(id)
    } finally { db.close() }
    await page.evaluate(id => window.yogurt.nav.go(`/note/${id}`), id)
    await page.getByTestId('note-transcript-toggle').click()
    const row = page.getByTestId('transcript-line').nth(12)
    const time = row.getByRole('button', { name: 'Play from 0:06', exact: true })
    const words = row.getByTestId('transcript-text')
    await expect(time).toBeVisible()
    await expect(row.getByRole('button')).toHaveCount(1)
    await words.click()
    await expect(words).not.toHaveAttribute('contenteditable', 'plaintext-only')
    await expect(page.getByTestId('player-toggle')).toHaveAccessibleName('Play')
    await row.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Space')
    await expect(page.getByTestId('player-toggle')).toHaveAccessibleName('Play')
    await time.click()
    await expect(page.getByTestId('player-toggle')).toHaveAccessibleName('Pause')
    await expect.poll(async () => (await audioState(page)).some(a => !a.paused && a.time >= 5)).toBe(true)
  } finally { await app.close() }
})

test('the transcript follows new lines, unless the person scrolled up to read', async () => {
  const { app, page } = await launch()
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await startMeeting(app, page)
    const list = page.getByTestId('transcript')
    await expect(list).toBeVisible()
    // a short list, so a few lines overflow it
    await list.evaluate((el) => { el.style.flex = 'none'; el.style.height = '60px' })
    const lines = page.getByTestId('transcript-line')
    await expect(lines.filter({ hasText: 'The site goes live on Tuesday' })).toBeVisible({ timeout: 30_000 })
    const atBottom = () => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4)
    await expect.poll(atBottom).toBe(true)
    await list.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
    await expect(lines.filter({ hasText: 'Who is writing the release notes' })).toHaveCount(1, { timeout: 30_000 })
    await page.waitForTimeout(300)
    expect(await list.evaluate((el) => el.scrollTop)).toBe(0)
    // the pill takes them back to the newest line, and following goes on
    // Reduced motion reaches the newest line immediately, with no smooth-scroll travel.
    expect(await page.getByTestId('transcript-latest').evaluate((button) => {
      ;(button as HTMLButtonElement).click()
      const list = document.querySelector('[data-testid="transcript"]')!
      return list.scrollHeight - list.scrollTop - list.clientHeight < 4
    })).toBe(true)
    await expect.poll(atBottom).toBe(true)
    await expect(page.getByTestId('transcript-latest')).toHaveCount(0)
    await expect(lines.filter({ hasText: 'She will send a draft' })).toHaveCount(1, { timeout: 30_000 })
    await expect.poll(atBottom).toBe(true)
  } finally { await app.close() }
})

test('after the meeting, clicking a line time plays both sides from a second before it, with pause and speed', async () => {
  const { app, page } = await launch()
  try {
    await startMeeting(app, page)
    const lines = page.getByTestId('transcript-line')
    await expect(lines.filter({ hasText: 'She will send a draft' })).toBeVisible({ timeout: 40_000 })
    await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('note-summary-tab')).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('player')).toBeVisible({ timeout: 15_000 })
    await expect(audioOf(page)).toHaveCount(2)
    // the line at 13.3 s plays from 12.3 s, on both tracks
    await lines.filter({ hasText: 'She will send a draft' }).getByRole('button', { name: /^Play from/ }).click()
    await expect.poll(async () => (await audioState(page)).every((a) => !a.paused && a.time >= 12.2 && a.time < 14.5)).toBe(true)
    await expect(page.getByTestId('player-toggle')).toHaveAttribute('aria-label', 'Pause')
    // faster, on both
    await page.getByTestId('player-speed').click()
    await expect(page.getByTestId('player-speed')).toHaveText('1.5×')
    await expect.poll(async () => (await audioState(page)).map((a) => a.rate)).toEqual([1.5, 1.5])
    await page.getByTestId('player-speed').click()
    await expect.poll(async () => (await audioState(page)).map((a) => a.rate)).toEqual([2, 2])
    // the line being played is marked, theirs as well as yours
    const playingLine = page.locator('[data-testid="transcript-line"][data-playing]')
    await expect(playingLine).toHaveCount(1)
    await expect(playingLine).toContainText('She will send a draft')
    await page.getByTestId('player-toggle').click()
    await expect.poll(async () => (await audioState(page)).every((a) => a.paused)).toBe(true)
    // paused, the mark stays where it stopped
    await expect(playingLine).toContainText('She will send a draft')
    // the scrubber moves both, and the mark jumps with it at once, while paused too
    await page.getByTestId('player-scrubber').fill('3')
    await expect.poll(async () => (await audioState(page)).map((a) => Math.round(a.time))).toEqual([3, 3])
    await expect(playingLine).toContainText('Can we go over the launch plan')
    await page.getByTestId('player-scrubber').fill('6')
    await expect(playingLine).toHaveAttribute('data-track', 'them')
    // a line near the start never seeks before 0
    await lines.filter({ hasText: 'Can we go over the launch plan' }).getByRole('button', { name: /^Play from/ }).click()
    await expect.poll(async () => (await audioState(page)).every((a) => !a.paused && a.time < 1.5)).toBe(true)
    const tracks = await audioOf(page).elementHandles()
    await page.getByRole('tab', { name: 'My notes', exact: true }).click()
    await expect(page.getByTestId('player')).toHaveCount(0)
    await expect(page.getByRole('tab', { name: 'My notes', exact: true })).toBeFocused()
    for (const track of tracks) expect(await track.evaluate((a) => (a as HTMLAudioElement).paused)).toBe(true)
  } finally { await app.close() }
})

/** a stopped meeting with its player ready; returns its id */
async function stopped(app: ElectronApplication, page: Page) {
  await startMeeting(app, page)
  await expect(page.getByTestId('transcript-line').filter({ hasText: 'She will send a draft' })).toBeVisible({ timeout: 40_000 })
  await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('note-summary-tab')).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('note-transcript-toggle').click()
  await expect(page.getByTestId('player')).toBeVisible({ timeout: 15_000 })
  return (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
}

test('the transcript scrolls behind its pill and the final line can clear the controls', async () => {
  const { app, page } = await launch()
  try {
    await stopped(app, page)
    const list = page.getByTestId('transcript'), player = page.getByTestId('player')
    const bottom = (await list.boundingBox())!
    const controls = (await player.boundingBox())!
    expect(controls.width).toBeLessThanOrEqual(412)
    await expect(player).toHaveCSS('border-radius', '22px')
    expect(bottom.y + bottom.height).toBeGreaterThan(controls.y + controls.height)
    const footer = (await page.locator('.note-footer').boundingBox())!
    expect(footer.y - controls.y - controls.height).toBeLessThanOrEqual(12)
    await list.evaluate(el => { el.scrollTop = el.scrollHeight })
    const last = (await page.getByTestId('transcript-turn').last().boundingBox())!
    expect(last.y + last.height).toBeLessThan(controls.y)
    await page.getByTestId('player-toggle').click()
    await expect(page.getByTestId('player-toggle')).toHaveAttribute('aria-label', 'Pause')
    await page.getByTestId('player-speed').click()
    await expect(page.getByTestId('player-speed')).toHaveText('1.5×')
    await page.emulateMedia({ contrast: 'more' })
    await expect(player).toHaveCSS('backdrop-filter', 'none')
    await expect(player).toHaveCSS('background-color', /^rgb\(/)
  } finally { await app.close() }
})
/** replaces a track's stand-in file: seconds of silence, or bytes that are not audio, or nothing */
const setTrack = (app: ElectronApplication, id: string, track: string, what: number | 'garbage' | 'gone') =>
  app.evaluate((_e, [id, track, what]) => {
    const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs'), path = process.getBuiltinModule('node:path') as typeof import('node:path')
    const file = path.join(process.env.YOGURT_USER_DATA!, 'meetings', id, `${track}.wav`)
    if (what === 'gone') { fs.rmSync(file); return }
    if (what === 'garbage') { fs.writeFileSync(file, Buffer.alloc(4000, 7)); return }
    const n = (what as number) * 16000, b = Buffer.alloc(44 + n * 2)
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
    b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
    fs.writeFileSync(file, b)
  }, [id, track, what] as const)
const reopen = async (page: Page) => {
  await page.reload()
  await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
  await expect(page.getByTestId('player')).toBeVisible({ timeout: 15_000 })
}

test('a side that ends early, is missing, or cannot be read: the other still plays', async () => {
  const { app, page } = await launch()
  try {
    const id = await stopped(app, page)
    const lines = page.getByTestId('transcript-line')
    // their side is only 5 s long: the line at 13.3 s plays your side, and the button says it is playing
    await setTrack(app, id, 'them', 5)
    await reopen(page)
    await expect.poll(async () => (await audioState(page)).length).toBe(2)
    await lines.filter({ hasText: 'She will send a draft' }).getByRole('button', { name: /^Play from/ }).click()
    await expect.poll(async () => (await audioState(page)).find((a) => a.track === 'me')).toMatchObject({ paused: false })
    await expect(page.getByTestId('player-toggle')).toHaveAttribute('aria-label', 'Pause')
    // back to 2 s while playing: their side plays again too
    await page.getByTestId('player-scrubber').fill('2')
    await expect.poll(async () => (await audioState(page)).every((a) => !a.paused && a.time < 4)).toBe(true)
    // their side gone: one track plays
    await setTrack(app, id, 'them', 'gone')
    await reopen(page)
    await expect(audioOf(page)).toHaveCount(1)
    await lines.filter({ hasText: 'She will send a draft' }).getByRole('button', { name: /^Play from/ }).click()
    await expect.poll(async () => (await audioState(page)).every((a) => !a.paused && a.time >= 12.2)).toBe(true)
    // their side unreadable: it is dropped, they are told, and your side plays
    await setTrack(app, id, 'them', 'garbage')
    await reopen(page)
    await expect(page.getByTestId('player-note')).toHaveText("Part of this recording can't be played.")
    await expect(audioOf(page)).toHaveCount(1)
    await lines.filter({ hasText: 'She will send a draft' }).getByRole('button', { name: /^Play from/ }).click()
    await expect.poll(async () => (await audioState(page)).every((a) => !a.paused && a.time >= 12.2)).toBe(true)
    // nothing readable: no controls, just the note
    await setTrack(app, id, 'me', 'garbage')
    await reopen(page).catch(() => {})
    await expect(page.getByTestId('player-note')).toHaveText("This recording can't be played.")
    await expect(page.getByTestId('player-retry')).toBeEnabled()
    await page.getByTestId('player-open-transcript').click()
    await expect(page.getByTestId('transcript-line').first()).toBeFocused()
    await expect(page.getByTestId('player-toggle')).toHaveCount(0)
  } finally { await app.close() }
})

test('the play button follows the audio, and lines are one tab stop moved with the arrow keys', async () => {
  const { app, page } = await launch()
  try {
    await stopped(app, page)
    const lines = page.getByTestId('transcript-line')
    await lines.filter({ hasText: 'The site goes live' }).getByRole('button', { name: /^Play from/ }).click()
    await expect(page.getByTestId('player-toggle')).toHaveAttribute('aria-label', 'Pause')
    // stopped by anything but the button (the system, an error): the button says Play
    await audioOf(page).evaluateAll((els) => (els as HTMLAudioElement[]).forEach((a) => a.pause()))
    await expect(page.getByTestId('player-toggle')).toHaveAttribute('aria-label', 'Play')
    await expect(page.getByTestId('player-speed')).toHaveAttribute('aria-label', 'Playback speed 1×')
    // one line in the tab order; arrows move between lines, Tab reaches the time
    expect(await lines.evaluateAll((els) => els.filter((e) => (e as HTMLElement).tabIndex === 0).length)).toBe(1)
    await expect(lines.first()).toHaveAttribute('role', 'group')
    await lines.first().focus()
    await page.keyboard.press('ArrowDown')
    await expect(lines.nth(1)).toBeFocused()
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown')
    await expect(lines.nth(3)).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(lines.nth(3).getByRole('button', { name: /^Play from/ })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await audioState(page)).every((a) => !a.paused && a.time >= 12.2 && a.time < 14.5)).toBe(true)
  } finally { await app.close() }
})

test('a long meeting opens fast, and playing redraws only the line that changes', async () => {
  const { app, page } = await launch()
  try {
    const n = 3000
    const id = await fake<string>(app, 'bigMeeting', n)
    await fake(app, 'go', `/note/${id}`)
    await expect(page.getByTestId('note-title')).toBeVisible()
    const t0 = Date.now()
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await expect(page.getByTestId('transcript-line')).toHaveCount(n)
    const opened = Date.now() - t0
    console.log(`${n} lines open in ${opened} ms`)
    expect(opened).toBeLessThan(3000)
    // lines already said do not animate in
    await expect(page.locator('.line-in')).toHaveCount(0)
    await expect(page.getByTestId('player')).toBeVisible()
    await page.evaluate(() => { (window as unknown as { __rowRenders: number }).__rowRenders = 0 })
    await page.getByTestId('transcript-line').nth(10).getByRole('button', { name: /^Play from/ }).click()
    await page.waitForTimeout(2500)
    const renders = await page.evaluate(() => (window as unknown as { __rowRenders: number }).__rowRenders)
    console.log('row renders while playing 2.5 s:', renders)
    expect(renders).toBeLessThan(40)
  } finally { await app.close() }
})

/** a long finished meeting playing at 2× (lines half a second apart), with helpers to see where the line being played is */
async function playingLong(app: ElectronApplication, page: Page) {
  const id = await fake<string>(app, 'bigMeeting', 400)
  await fake(app, 'go', `/note/${id}`)
  await page.getByTestId('note-transcript-toggle').click()
  await expect(page.getByTestId('player')).toBeVisible()
  const list = page.getByTestId('transcript')
  const playingLine = page.locator('[data-testid="transcript-line"][data-playing]')
  const playingNo = async () => Number((await playingLine.textContent())?.match(/Line (\d+) /)?.[1])
  /** where the line being played sits in the list, as a share of its height (0 top, 1 bottom) */
  const where = () => page.evaluate(() => {
    const l = document.querySelector('[data-testid="transcript"]')!.getBoundingClientRect()
    const r = document.querySelector('[data-testid="transcript-line"][data-playing]')?.getBoundingClientRect()
    return r ? (r.top - l.top) / l.height : null
  })
  const comfy = async () => { const at = await where(); return at !== null && at > 0 && at < 0.75 }
  const scrollTop = () => list.evaluate((el) => el.scrollTop)
  const box = (await list.boundingBox())!
  /** they turn the wheel up over the list */
  const scrollUp = async () => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -100_000)
    await expect.poll(scrollTop).toBeLessThan(40)
  }
  await page.getByTestId('player-speed').click(); await page.getByTestId('player-speed').click()
  await expect(page.getByTestId('player-speed')).toHaveText('2×')
  // the panel settled, so a click lands where it is aimed
  await page.getByTestId('transcript-panel').evaluate((el) => Promise.allSettled(el.getAnimations({ subtree: true }).map((a) => a.finished)))
  return { playingLine, playingNo, where, comfy, scrollTop, scrollUp }
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) test(`scrubbing follows the playhead while paused and after scrolling away (${reducedMotion})`, async () => {
  const { app, page } = await launch()
  try {
    await page.emulateMedia({ reducedMotion })
    const { playingNo, comfy, scrollTop, scrollUp } = await playingLong(app, page)
    const scrubber = page.getByTestId('player-scrubber')
    // Seeking while paused must move the viewport as well as the highlight.
    await scrubber.fill('30')
    await expect.poll(playingNo).toBe(61)
    await expect.poll(comfy).toBe(true)
    await expect(page.getByTestId('player-toggle')).toHaveAttribute('aria-label', 'Play')
    // The seek glide finishes before checking that an idle paused player stays still.
    await page.waitForTimeout(300)
    const settled = await scrollTop()
    await page.waitForTimeout(500)
    expect(await scrollTop()).toBe(settled)

    // A fresh seek wins over reading elsewhere, even within the same highlighted line.
    await scrollUp()
    await scrubber.fill('30.1')
    await expect.poll(playingNo).toBe(61)
    await expect.poll(comfy).toBe(true)
    await scrubber.fill('5')
    await expect.poll(playingNo).toBe(11)
    await expect.poll(comfy).toBe(true)

    await page.getByTestId('player-toggle').click()
    await scrubber.fill('80')
    await expect.poll(comfy).toBe(true)
    await scrollUp()
    await expect(page.getByTestId('transcript-follow')).toBeVisible()
    // Drag the real range control: its pointer gesture is not a transcript scroll.
    const box = (await scrubber.boundingBox())!
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect.poll(playingNo).toBeGreaterThan(250)
    await expect.poll(comfy).toBe(true)
    await expect(page.getByTestId('transcript-follow')).toHaveCount(0)
  } finally { await app.close() }
})

test('playing follows along: the line being played moves down the list and stays in view; scrolling away stops it until Back to playing', async () => {
  test.setTimeout(90_000)
  const { app, page } = await launch()
  try {
    const { playingNo, where, comfy, scrollTop, scrollUp } = await playingLong(app, page)
    // the mark moves line to line, from a second before the one clicked
    await page.getByTestId('transcript-line').nth(4).getByRole('button', { name: /^Play from/ }).click()
    await expect.poll(playingNo).toBeGreaterThanOrEqual(4)
    const first = await playingNo()
    await expect.poll(playingNo).toBeGreaterThan(first + 2)
    // past the first screenful the list scrolls, keeping the line clear of the edges
    await expect.poll(playingNo, { timeout: 15_000 }).toBeGreaterThan(20)
    expect(await scrollTop()).toBeGreaterThan(0)
    for (let i = 0; i < 4; i++) {
      const at = await where()
      expect(at).not.toBeNull()
      expect(at!).toBeGreaterThan(0)
      expect(at!).toBeLessThan(0.75)
      await page.waitForTimeout(400)
    }
    await expect(page.getByTestId('transcript-follow')).toHaveCount(0)

    // they scroll back up to read: the list stays where they put it, and offers a way back
    await scrollUp()
    await expect(page.getByTestId('transcript-follow')).toBeVisible()
    await expect(page.getByTestId('transcript-follow')).toHaveText('Back to playing')
    const left = await playingNo(), put = await scrollTop()
    await expect.poll(playingNo).toBeGreaterThan(left + 3)
    expect(await scrollTop()).toBe(put)

    // Back to playing brings the line back into view and follows again
    await page.getByTestId('transcript-follow').click()
    await expect(page.getByTestId('transcript-follow')).toHaveCount(0)
    await expect.poll(comfy).toBe(true)
    const back = await playingNo()
    await expect.poll(playingNo, { timeout: 10_000 }).toBeGreaterThan(back + 8)
    await expect.poll(comfy).toBe(true)
  } finally { await app.close() }
})

test('paused, the mark stays and nothing scrolls; clicking a line follows again; a search that leaves the line out jumps nowhere', async () => {
  test.setTimeout(90_000)
  const { app, page } = await launch()
  try {
    const { playingLine, playingNo, comfy, scrollTop, scrollUp } = await playingLong(app, page)
    // the scrubber moves the mark at once, and the list with it
    await page.getByTestId('transcript-line').nth(2).getByRole('button', { name: /^Play from/ }).click()
    await page.getByTestId('player-scrubber').fill('30')
    await expect.poll(playingNo).toBeGreaterThanOrEqual(61)
    await expect.poll(comfy).toBe(true)

    // paused: the mark stays, nothing scrolls
    await page.getByTestId('player-toggle').click()
    await expect(page.getByTestId('player-toggle')).toHaveAttribute('aria-label', 'Play')
    // a glide that began just before the pause finishes first
    await page.waitForTimeout(500)
    const stoppedAt = await playingNo(), top = await scrollTop()
    await page.waitForTimeout(1200)
    expect(await playingNo()).toBe(stoppedAt)
    expect(await scrollTop()).toBe(top)

    // scrolled away, then playing again: it doesn't pull them back; clicking a line plays from it and follows again
    await scrollUp()
    await page.getByTestId('player-toggle').click()
    await expect(page.getByTestId('transcript-follow')).toBeVisible()
    await page.getByTestId('transcript-line').nth(2).getByRole('button', { name: /^Play from/ }).click()
    await expect(page.getByTestId('transcript-follow')).toHaveCount(0)
    await expect.poll(playingNo, { timeout: 15_000 }).toBeGreaterThan(20)
    await expect.poll(comfy).toBe(true)

    // with less motion asked for, the list jumps instead of gliding
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByTestId('player-scrubber').fill('77.2')
    await expect.poll(playingNo).toBe(155)
    // Highlighting renders before the coalesced scroll frame, even when reduced motion jumps instead of gliding.
    await expect.poll(comfy).toBe(true)
    // Finding keeps the playing line, but playback must not take over the search position.
    await page.getByTestId('transcript-find-open').click()
    await page.getByTestId('transcript-search').fill('0')
    await expect(playingLine).toHaveCount(1)
    const searched = await scrollTop()
    await page.waitForTimeout(800)
    expect(await scrollTop()).toBe(searched)
    await expect(page.getByTestId('transcript-follow')).toHaveCount(0)
  } finally { await app.close() }
})

for (const colorScheme of ['light', 'dark'] as const) test(`the player pill hides only for reading scrolls in ${colorScheme}`, async ({}, testInfo) => {
  const { app, page } = await launch()
  try {
    await page.context().tracing.start({ screenshots: true, snapshots: true })
    await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference' })
    const id = await fake<string>(app, 'bigMeeting', 400)
    await fake(app, 'go', `/note/${id}`)
    await page.getByTestId('note-transcript-toggle').click()
    const list = page.getByTestId('transcript'), player = page.getByTestId('player')
    const dock = page.locator('.transcript-player-dock')
    await expect(player).toBeVisible()
    await expect(list).toHaveAttribute('data-loaded', 'true')
    await expect(page.getByTestId('transcript-line')).toHaveCount(400)
    await expect.poll(() => list.evaluate(el => el.clientHeight > 0 && el.scrollHeight - el.clientHeight > 600)).toBe(true)
    // Hover waits for the live list to receive input after the tab's view transition.
    await list.hover()
    // Moving the list without user input never hides the controls.
    await list.evaluate(el => { el.scrollTop = 240 })
    await expect.poll(() => list.evaluate(el => el.scrollTop)).toBe(240)
    await expect(dock).toHaveAttribute('data-hidden', 'false')
    await page.mouse.wheel(0, 120)
    await expect(dock).toHaveAttribute('data-hidden', 'true')
    await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThanOrEqual(264)
    await expect(player).toHaveCSS('opacity', '0')
    await page.mouse.wheel(0, -40)
    await expect(dock).toHaveAttribute('data-hidden', 'false')
    await expect(player).toHaveCSS('opacity', '1')
    // Opacity finishes before the return spring settles.
    await expect.poll(() => player.evaluate(el => el.getAnimations().length)).toBe(0)
    await page.mouse.wheel(0, 120)
    await expect(dock).toHaveAttribute('data-hidden', 'true')
    await expect(dock).toHaveAttribute('data-hidden', 'false', { timeout: 2000 })
    await expect(player).toHaveCSS('opacity', '1')
    await expect.poll(() => player.evaluate(el => el.getAnimations().length)).toBe(0)

    await page.getByTestId('player-toggle').focus()
    await page.mouse.wheel(0, 120)
    await expect(dock).toHaveAttribute('data-hidden', 'false')
    await page.getByTestId('recording-menu').click()
    await expect(page.getByTestId('recording-delete')).toBeVisible()
    await list.hover()
    await page.mouse.wheel(0, 120)
    await expect(dock).toHaveAttribute('data-hidden', 'false')
    await page.keyboard.press('Escape')
    await page.getByTestId('player-toggle').click()
    await expect(page.getByTestId('player-toggle')).toHaveAttribute('aria-label', 'Pause')
    await list.evaluate(el => { el.tabIndex = -1; el.focus({ preventScroll: true }) })
    await list.hover()
    await page.mouse.wheel(0, 120)
    await expect(dock).toHaveAttribute('data-hidden', 'false')

    await page.getByTestId('player-toggle').click()
    await expect(page.getByTestId('player-toggle')).toHaveAttribute('aria-label', 'Play')
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await list.evaluate(el => { el.focus({ preventScroll: true }); el.scrollTop = 240 })
    await expect.poll(() => list.evaluate(el => el.scrollTop)).toBe(240)
    await list.hover()
    await page.mouse.wheel(0, 120)
    await expect(dock).toHaveAttribute('data-hidden', 'true')
    await expect(player).toHaveCSS('transform', 'none')
    await expect(player).toHaveCSS('transition-property', 'opacity')
    await list.evaluate(el => { el.scrollTop = el.scrollHeight })
    await expect(dock).toHaveAttribute('data-hidden', 'false')
    await expect(player).toHaveCSS('opacity', '1')
    await expect.poll(() => player.evaluate(el => el.getAnimations().length)).toBe(0)
    const last = (await page.getByTestId('transcript-turn').last().boundingBox())!
    const pill = (await player.boundingBox())!
    expect(last.y + last.height).toBeLessThan(pill.y)
  } finally {
    await page.context().tracing.stop({ path: testInfo.outputPath('trace.zip') }).finally(() => app.close())
  }
})

test('find navigates a long transcript without filtering or redrawing its rows', async () => {
  const { app, page } = await launch()
  try {
    const id = await fake<string>(app, 'bigMeeting', 5400)
    await fake(app, 'go', `/note/${id}`)
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('transcript-line')).toHaveCount(5400)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.keyboard.press('ControlOrMeta+f')
    const input = page.getByTestId('transcript-search'), count = page.getByTestId('transcript-find-count')
    await expect(input).toBeFocused()
    const rendered = () => page.evaluate(() => (window as unknown as { __rowRenders: number }).__rowRenders)
    const before = await rendered()
    await input.fill('long meeting')
    await expect(count).toHaveText('1 of 5,400')
    await expect(page.getByTestId('transcript-line')).toHaveCount(5400)
    const hit = () => page.evaluate(() => {
      const range = CSS.highlights.get('transcript-find-current')?.values().next().value as Range | undefined
      return range?.startContainer.parentElement?.closest<HTMLElement>('[data-key]')?.dataset.key
    })
    const first = await hit()
    await input.press('Shift+Enter')
    await expect(count).toHaveText('5,400 of 5,400')
    expect(await hit()).not.toBe(first)
    await expect.poll(() => page.evaluate(() => {
      const range = CSS.highlights.get('transcript-find-current')?.values().next().value as Range | undefined
      const el = document.querySelector('[data-testid="transcript"]')!
      const r = range?.getBoundingClientRect(), box = el.getBoundingClientRect()
      return !!r && r.top >= box.top && r.bottom <= box.bottom
    })).toBe(true)
    await page.keyboard.press('ControlOrMeta+g')
    await expect(count).toHaveText('1 of 5,400')
    expect(await hit()).toBe(first)
    await page.keyboard.press('ControlOrMeta+Shift+g')
    await expect(count).toHaveText('5,400 of 5,400')
    await input.press('Enter')
    await expect(count).toHaveText('1 of 5,400')
    expect(await rendered()).toBe(before)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('transcript-find-open')).toBeFocused()
    expect(await page.evaluate(() => CSS.highlights.get('transcript-find')?.size ?? 0)).toBe(0)
    await page.getByTestId('note-notes-tab').click()
    await page.keyboard.press('ControlOrMeta+f')
    await expect(input).toHaveCount(0)
    await expect(page.getByTestId('note-notes-tab')).toBeFocused()
  } finally { await app.close() }
})

for (const theme of ['light','dark'] as const) test(`recording and transcribing keep Edit in the transcript toolbar (${theme})`, async ({},testInfo)=>{
  const {app,page,userData}=await launch()
  try {
    await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'})
    const captureUnavailable=async (state:string, reason:string) => {
      const edit=page.locator('.note-primary-tools').getByTestId('transcript-edit')
      await expect(edit).toBeDisabled()
      await expect(edit).toHaveAttribute('title',reason)
      await expect(page.getByText(reason,{exact:true})).toHaveCount(0)
      await page.keyboard.press('ControlOrMeta+Alt+e')
      await expect(page.getByTestId('transcript-document')).toHaveCount(0)
      await expect(page.getByTestId('transcript-line').first()).toBeVisible({timeout:30000})
      await page.screenshot({path:testInfo.outputPath(`edit-${state}-${theme}.png`)})
    }
    const id=await fake<string>(app,'bigMeeting',4)
    const db=new DatabaseSync(join(userData,'yogurt.db'),{timeout:5000})
    try { db.prepare("UPDATE meetings SET transcription_pending=1,transcription_state='transcribing' WHERE id=?").run(id) } finally { db.close() }
    await fake(app,'go',`/note/${id}`)
    await page.getByTestId('note-transcript-toggle').click()
    await captureUnavailable('transcribing','Finish transcription to edit lines.')
    await startMeeting(app,page)
    await captureUnavailable('recording','Available after recording')
  } finally { await app.close() }
})

for (const theme of ['light','dark'] as const) test(`edit, remove and review a finished transcript (${theme})`, async ({}, testInfo) => {
  const { app,page } = await launch()
  try {
    await page.emulateMedia({ colorScheme:theme, reducedMotion:'reduce' })
    const id = await fake<string>(app,'bigMeeting',12)
    await page.evaluate(async id=>{
      await window.yogurt.notes.setMine(id,'Keep my agenda.',1)
      await window.yogurt.notes.setEnhanced(id,'The earlier summary stays readable.',1)
      window.yogurt.nav.go(`/note/${id}`)
    },id)
    await page.getByTestId('note-transcript-toggle').click()
    const lines = page.getByTestId('transcript-line'), words = lines.first().getByTestId('transcript-text')
    const capture = (state:string) => page.screenshot({path:testInfo.outputPath(`edit-${state}-${theme}.png`)})
    const edit=page.getByTestId('transcript-edit'), done=page.getByTestId('transcript-done')
    const undo=page.getByRole('button',{name:'Undo',exact:true}), redo=page.getByRole('button',{name:'Redo',exact:true})
    await expect(edit).toBeVisible()
    await words.click()
    await expect(words).not.toHaveAttribute('data-editable','true')
    await expect(page.getByTestId('player-toggle')).toHaveAccessibleName('Play')
    await capture('read')
    await edit.click()
    await expect(done).toBeVisible()
    await expect(undo).toBeDisabled()
    await capture('idle')
    const point = (row:number, offset:number|'end') => lines.nth(row).getByTestId('transcript-text').evaluate((el,offset)=>{
      const text=el.firstChild!, r=document.createRange()
      r.setStart(text,offset==='end' ? text.textContent!.length : offset); r.collapse(true)
      const box=r.getBoundingClientRect()
      return {x:box.left,y:box.top+box.height/2}
    },offset)
    const word=await point(0,2)
    await page.mouse.dblclick(word.x,word.y)
    await page.keyboard.insertText('Part')
    await expect(words).toContainText('Part')
    await capture('word')
    await page.keyboard.press('Enter')
    await expect(lines.first()).toHaveAttribute('data-corrected','true')
    const start=await point(0,0), end=await point(1,'end')
    await page.mouse.move(start.x,start.y); await page.mouse.down()
    await page.mouse.move(end.x,end.y,{steps:12}); await page.mouse.up()
    expect(await page.evaluate(()=>window.getSelection()?.toString())).toContain('Line 2')
    await capture('two-lines')
    await page.keyboard.press('Backspace')
    await expect(lines).toHaveCount(10)
    await expect(undo).toBeEnabled()
    const geometry=await page.getByRole('group',{name:'Edit transcript'}).evaluate(el=>{
      const r=el.getBoundingClientRect(), list=el.closest('ol')!, box=list.getBoundingClientRect(), style=getComputedStyle(list)
      return {center:r.left+r.width/2, columnCenter:(box.left+parseFloat(style.paddingLeft)+box.right-parseFloat(style.paddingRight))/2,
        width:r.width, available:box.width-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)}
    })
    expect(Math.abs(geometry.center-geometry.columnCenter)).toBeLessThan(2)
    expect(geometry.width).toBeLessThan(geometry.available)
    await expect(page.getByRole('button',{name:'Undo',exact:true})).toHaveCount(1)
    await capture('removed')
    await page.keyboard.press('ControlOrMeta+z')
    await expect(lines).toHaveCount(12)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect(lines).toHaveCount(10)
    await undo.click()
    await expect(words).toContainText('Part')
    await expect(redo).toBeEnabled()
    await page.getByRole('button',{name:'Changes',exact:true}).click()
    const changes=page.getByRole('region',{name:'Changes'})
    await expect(changes.locator('del mark')).toHaveText('Line')
    await expect(changes.locator('ins mark')).toHaveText('Part')
    await capture('changes')
    await changes.getByRole('button',{name:'Restore original wording'}).click()
    await expect(words).toContainText('Line')
    await undo.click()
    await expect(words).toContainText('Part')
    await page.getByRole('button',{name:'Revert all'}).click()
    await expect(words).toContainText('Line')
    await undo.click()
    await expect(words).toContainText('Part')
    await done.click()
    await expect(edit).toBeFocused()
    await page.getByTestId('note-summary-tab').click()
    await expect(page.getByTestId('summary-review')).toBeVisible()
    await capture('summary-review')
    await page.getByTestId('summary-review').getByRole('button',{name:'Regenerate summary'}).click()
    await expect(page.getByTestId('note-confirm')).toContainText('Your edits to the summary will be replaced.')
    await page.getByTestId('note-regenerate').getByRole('button',{name:'Close',exact:true}).click()
    await page.getByRole('button',{name:'Mark as reviewed'}).click()
    await expect(page.getByTestId('summary-review')).toHaveCount(0)
    expect(await page.evaluate(id=>window.yogurt.notes.get(id),id)).toMatchObject({ mine:'Keep my agenda.', enhanced:'The earlier summary stays readable.' })
  } finally { await app.close() }
})

test('keeps selections and drafts through conflicts and failures, and restores focus after removing every line', async () => {
  const { app,page,userData } = await launch()
  const db = new DatabaseSync(join(userData,'yogurt.db'),{timeout:5000})
  try {
    const id = await fake<string>(app,'bigMeeting',3)
    await page.evaluate(id=>window.yogurt.nav.go(`/note/${id}`),id)
    await page.getByTestId('note-transcript-toggle').click()
    const rows = page.getByTestId('transcript-line'), words = rows.first().getByTestId('transcript-text')
    await expect(page.getByTestId('transcript-edit')).toBeEnabled()
    await page.keyboard.press('ControlOrMeta+Alt+e')
    const doc=page.getByRole('textbox',{name:'Transcript',exact:true})
    await expect(doc).toBeFocused()
    const point = (index:number,offset:number) => rows.nth(index).getByTestId('transcript-text').evaluate((el,offset)=>{
      const r=document.createRange(); r.setStart(el.firstChild!,offset); r.collapse(true)
      const box=r.getBoundingClientRect(); return {x:box.left,y:box.top+box.height/2}
    },offset)
    const start=await point(0,5), end=await point(1,5)
    await page.mouse.click(start.x,start.y)
    await page.keyboard.down('Shift'); await page.mouse.click(end.x,end.y); await page.keyboard.up('Shift')
    expect(await page.evaluate(()=>window.getSelection()?.toString())).toContain('of the long meeting')
    await page.keyboard.press('Delete')
    await expect(rows).toHaveCount(3)
    await expect(words).toHaveText('Line')
    await page.keyboard.press('ControlOrMeta+z')
    await expect(words).toHaveText('Line 1 of the long meeting.')
    const word=await point(0,2)
    await page.mouse.dblclick(word.x,word.y); await page.keyboard.insertText('Part')
    await page.evaluate(async id=>{
      const state=await window.yogurt.transcript.snapshot(id), line=state.lines[0]
      await window.yogurt.transcript.change(id,state.revision,{kind:'wording',id:line.id,expected:line.text,text:'Another saved correction'})
    },id)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('alert')).toContainText('Another saved correction')
    db.exec("CREATE TRIGGER fail_wording BEFORE UPDATE OF text ON segments BEGIN SELECT RAISE(FAIL,'Test save failure'); END")
    await page.getByRole('button',{name:'Use my wording'}).click()
    await expect(page.getByRole('button',{name:'Try again'})).toBeVisible()
    db.exec('DROP TRIGGER fail_wording')
    await page.getByRole('button',{name:'Try again'}).click()
    await expect(words).toContainText('Part')
    await doc.focus(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Delete')
    await expect(rows).toHaveCount(0)
    await expect(page.getByTestId('transcript-empty')).toContainText('All transcript lines have been removed.')
    await expect(page.getByTestId('player-toggle')).toBeVisible()
    await page.getByRole('button',{name:'Revert all'}).click()
    await expect(rows).toHaveCount(3)
    await expect(words).toHaveText('Line 1 of the long meeting.')
    await doc.focus(); await page.keyboard.press('Home'); await page.keyboard.insertText('Saved ')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('transcript-edit')).toBeFocused()
    await expect(words).toContainText('Saved')
  } finally { db.close(); await app.close() }
})
