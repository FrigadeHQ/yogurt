import { _electron as electron, expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const files = (dir: string) => existsSync(dir) ? readdirSync(dir) : []

test('Settings → Transcription: another speech model downloads, then takes over and the old one is removed', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-speech-model-'))
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, YOGURT_FAKE_LLM_MS: '2',
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    await page.evaluate(() => window.yogurt.nav.go('/settings'))
    const speech = page.getByTestId('settings-speech')
    await expect(speech.locator('option')).toHaveText(['Auto (Whisper large-v3-turbo)', 'Whisper large-v3-turbo · 574 MB', 'Whisper small · 190 MB', 'Whisper base · 60 MB', 'Whisper tiny · 32 MB'])
    await expect(page.getByTestId('settings-speech-status')).toHaveText('Always on this computer. Transcribing with Whisper large-v3-turbo.')
    await speech.selectOption('whisper-small-q5_1')
    await expect(page.getByTestId('settings-speech-status')).toHaveText('Always on this computer. Transcribing with Whisper small.', { timeout: 15_000 })
    const asr = files(join(userData, 'models', 'asr'))
    expect(asr.some((f) => f.includes('small'))).toBe(true)
    expect(asr.some((f) => f.includes('turbo'))).toBe(false)
    expect(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).speechModel).toBe('whisper-small-q5_1')
    // back to Auto: this computer's pick again
    await speech.selectOption('auto')
    await expect(page.getByTestId('settings-speech-status')).toHaveText('Always on this computer. Transcribing with Whisper large-v3-turbo.', { timeout: 15_000 })
    expect(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).speechModel).toBeUndefined()
  } finally { await app.close() }
})
