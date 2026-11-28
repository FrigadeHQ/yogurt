import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('uses the selected Portuguese language for an upload and a replacement transcript', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-saved-language-'))
  const audio = process.env.YOGURT_TEST_PT_WAV ?? join(import.meta.dirname, 'fixtures/meeting-me.wav')
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData,
  } })
  const languages = () => app.evaluate(() =>
    (globalThis as unknown as { __fake__: { prompts(): { languages: string[] } } }).__fake__.prompts().languages)
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await app.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] })
    }, audio)
    await page.evaluate(async () => {
      const file = await window.yogurt.audioUpload.pick()
      if (file) document.dispatchEvent(new CustomEvent('audio-upload-open', { detail: { file } }))
    })
    const upload = page.getByTestId('audio-upload')
    await upload.getByTestId('transcription-language').selectOption('pt')
    await upload.getByRole('button', { name: 'Transcribe', exact: true }).click()
    await expect(page.getByTestId('note')).toBeVisible()
    const id = await page.evaluate(async () => (await window.yogurt.nav.current()).split('/').pop()!)
    await expect.poll(async () => (await languages()).length).toBeGreaterThan(0)
    expect(new Set(await languages())).toEqual(new Set(['pt']))
    await expect.poll(() => page.evaluate(async id => !!(await window.yogurt.notes.get(id)).enhanced?.trim(), id)).toBe(true)

    const before = (await languages()).length
    await page.getByTestId('note-menu-button').click()
    await page.getByTestId('note-transcribe-again').click()
    const replacement = page.getByTestId('transcription-language-dialog')
    await replacement.getByTestId('transcription-language').selectOption('pt')
    await replacement.getByRole('button', { name: 'Transcribe again', exact: true }).click()
    await expect.poll(async () => (await languages()).slice(before)).toContain('pt')
    await expect.poll(() => page.evaluate(async id => (await window.yogurt.meetings.get(id))?.transcriptionState, id)).toBe('done')
    expect(await page.evaluate(async () => (await window.yogurt.settings.get()).spoken)).toBe('en')
  } finally { await app.close() }
})
