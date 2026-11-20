import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('the native clock accepts only a valid time and keeps an incomplete upload open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-upload-time-'))
  const file = join(dir, 'Planning.wav')
  const wav = Buffer.alloc(44 + 32000)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40)
  writeFileSync(file, wav)
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: dir } })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ dialog }, path) => { Object.assign(dialog, { showOpenDialog: async () => ({ canceled: false, filePaths: [path] }) }) }, file)
    await page.getByTestId('recording-choices').click()
    await page.getByTestId('recording-upload').click()
    const time = page.getByLabel('Start time', { exact: true })
    await expect(time).toHaveAttribute('type', 'time')
    expect(await time.evaluate((el: HTMLInputElement) => {
      const copy = el.cloneNode() as HTMLInputElement
      copy.value = '25:30'
      return copy.value
    })).toBe('')
    await time.fill('')
    await page.getByRole('button', { name: 'Transcribe' }).click()
    await expect(time).toHaveValue('')
    await expect(time).toHaveAttribute('aria-invalid', 'true')
    await time.fill('08:30')
    await time.press('Tab')
    await expect(time).not.toHaveAttribute('aria-invalid', 'true')
  } finally { await app.close() }
})
