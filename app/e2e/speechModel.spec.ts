import { _electron as electron, expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    await expect(speech.locator('option')).toHaveText(['Auto (Whisper large-v3-turbo)', 'Whisper large-v3-turbo · 574 MB', 'Whisper small · 190 MB', 'Whisper base · 60 MB', 'Whisper tiny · 32 MB', 'Choose a file…'])
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

/** a made-up file with a Whisper model's header (large-v3), as whisper.cpp writes it; fake mode never loads it */
function whisperFile(dir: string) {
  const head = Buffer.alloc(4 << 20)
  head.writeUInt32LE(0x67676d6c, 0)
  ;[51866, 1500, 1280, 20, 32, 448, 1280, 20, 32, 128, 1].forEach((v, i) => head.writeInt32LE(v, 4 + i * 4))
  writeFileSync(join(dir, 'ggml-own.bin'), head)
  return join(dir, 'ggml-own.bin')
}

test('Settings → Transcription: a Whisper file of your own takes over, and Auto again once it is moved away', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-speech-file-'))
  const notModel = join(userData, 'not-a-model.bin')
  writeFileSync(notModel, Buffer.alloc(1024))
  const own = whisperFile(userData)
  const launch = (file: string) => electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, YOGURT_FAKE_LLM_MS: '2', YOGURT_SPEECH_FILE: file,
  } })
  const settings = () => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))
  // a file that is not a Whisper model: said so, and the pick stays on Auto
  let app = await launch(notModel)
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    await page.evaluate(() => window.yogurt.nav.go('/settings'))
    const speech = page.getByTestId('settings-speech')
    await speech.selectOption('choose-file')
    await expect(page.getByTestId('settings-speech-status')).toHaveText("Always on this computer. That file isn't a Whisper model for whisper.cpp (a ggml .bin file).")
    await expect(speech).toHaveValue('auto')
  } finally { await app.close() }
  app = await launch(own)
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    await page.evaluate(() => window.yogurt.nav.go('/settings'))
    const speech = page.getByTestId('settings-speech')
    await speech.selectOption('choose-file')
    await expect(page.getByTestId('settings-speech-status')).toHaveText("Always on this computer. Transcribing with your own file, ggml-own.bin. Yogurt hasn't checked how well it works.", { timeout: 15_000 })
    await expect(speech).toHaveValue('own-file')
    await expect(speech.locator('option[value="own-file"]')).toHaveText('Your own file: ggml-own.bin · 4 MB')
    expect(settings().speechFile).toBe(own)
    // used where it is: nothing copied, and Auto's model stays beside it
    expect(files(join(userData, 'models', 'asr')).filter((f) => f.endsWith('.bin'))).toEqual(['ggml-large-v3-turbo-q5_0.bin'])
    // moved away, and back to Yogurt: Auto again, saying why
    rmSync(own)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByTestId('settings-speech-status')).toHaveText('Always on this computer. ggml-own.bin was moved, deleted or changed, so Yogurt went back to Auto. Transcribing with Whisper large-v3-turbo.', { timeout: 15_000 })
    await expect(speech).toHaveValue('auto')
    expect(settings().speechFile).toBeUndefined()
  } finally { await app.close() }
})
