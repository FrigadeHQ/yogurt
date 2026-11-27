import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('applies a manual Whisper model to one replacement and defaults back to Auto', async () => {
  const audio = process.env.YOGURT_TEST_PT_WAV ?? join(import.meta.dirname, 'fixtures/meeting-me.wav')
  const original = readFileSync(audio)
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-retranscription-model-'))
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData,
  } })
  const models = () => app.evaluate(() =>
    (globalThis as unknown as { __fake__: { prompts(): { models: string[] } } }).__fake__.prompts().models)
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await app.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] })
    }, audio)
    await page.evaluate(async () => {
      await window.yogurt.settings.setSpoken('multi')
      const file = await window.yogurt.audioUpload.pick()
      if (file) document.dispatchEvent(new CustomEvent('audio-upload-open', { detail: { file } }))
    })
    await page.getByTestId('audio-upload').getByRole('button', { name: 'Transcribe', exact: true }).click()
    await expect(page.getByTestId('note')).toBeVisible()
    const id = await page.evaluate(async () => (await window.yogurt.nav.current()).split('/').pop()!)
    const summary = () => page.evaluate(async id => (await window.yogurt.notes.get(id)).enhanced, id)
    await expect.poll(summary).toBeTruthy()
    const originalSummary = await summary()
    const automatic = (await models())[0]
    expect(automatic).toBeTruthy()
    expect(automatic).not.toBe('ggml-base-q5_1.bin')

    const openReplacement = async () => {
      await page.getByTestId('note-menu-button').click()
      await page.getByTestId('note-transcribe-again').click()
      const modal = page.getByTestId('retranscription-model-dialog')
      await expect(modal.getByTestId('retranscription-model')).toHaveValue('')
      return modal
    }
    const start = async (choice?: string) => {
      const before = (await models()).length
      const modal = await openReplacement()
      if (choice) await modal.getByTestId('retranscription-model').selectOption(choice)
      await modal.getByRole('button', { name: 'Transcribe again', exact: true }).click()
      await expect.poll(async () => (await models()).slice(before)).toContain(choice ? 'ggml-base-q5_1.bin' : automatic)
      await expect.poll(() => page.evaluate(async id => (await window.yogurt.meetings.get(id))?.transcriptionState, id)).toBe('done')
    }
    await start('whisper-base-q5_1')
    await start()
    expect(await summary()).toBe(originalSummary)
    expect(readFileSync(audio).equals(original)).toBe(true)
  } finally { await app.close() }
})
