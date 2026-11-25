import { _electron as electron, expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// @everywhere: the setup speed check of Windows and Linux (fake timings, YOGURT_FAKE_RTF). The Mac CI tries them through YOGURT_FAKE_PLATFORM.
const main = join(import.meta.dirname, '../out/main/index.js')
const launch = (env: Record<string, string>) => {
  const profile = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  return { profile, app: electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: profile, ...env } }) }
}
const stored = (profile: string) => JSON.parse(readFileSync(join(profile, 'speech-speed.json'), 'utf8'))

for (const platform of ['win32', 'linux']) {
  // a Reddit report: "won't install due to performance requirements". A computer that can't keep up live still records,
  // and its meetings are transcribed from the recording after they end
  test(`@everywhere on ${platform}: a computer that can't keep up live still gets ready, and transcribes after the meeting`, async () => {
    const { app: launching, profile } = launch({ YOGURT_FAKE_PLATFORM: platform, YOGURT_FAKE_RTF: '2' })
    const app = await launching
    try {
      const page = await app.firstWindow()
      await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
      await expect(page.getByTestId('setup-error')).toHaveCount(0)
      expect(stored(profile)).toMatchObject({ afterMeeting: true, rtf: { 'whisper-large-v3-turbo-q5_0': 2, 'whisper-small-q5_1': 2, 'whisper-base-q5_1': 2, 'whisper-tiny-q5_1': 2 } })
      expect(stored(profile).model).toEqual(expect.any(String))
    } finally { await app.close() }
  })

  test(`@everywhere on ${platform}: the best speech model that keeps up is kept, and recording is ready`, async () => {
    const { app: launching, profile } = launch({ YOGURT_FAKE_PLATFORM: platform, YOGURT_FAKE_RTF: 'whisper-large-v3-turbo-q5_0=0.9,whisper-small-q5_1=1.4' })
    const app = await launching
    try {
      const page = await app.firstWindow()
      await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
      // small may lag up to 1.25 times the clip (#107); slower than that, base is kept
      expect(stored(profile)).toMatchObject({ model: 'whisper-base-q5_1', rtf: { 'whisper-large-v3-turbo-q5_0': 0.9, 'whisper-small-q5_1': 1.4, 'whisper-base-q5_1': 0.1 } })
    } finally { await app.close() }
  })
}

test('@everywhere a Mac never times its speech model: turbo as always, even when every time would be too slow', async () => {
  const { app: launching, profile } = launch({ YOGURT_FAKE_PLATFORM: 'darwin', YOGURT_FAKE_RTF: '2' })
  const app = await launching
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    expect(existsSync(join(profile, 'speech-speed.json'))).toBe(false)
    expect(existsSync(join(profile, 'models', 'asr', 'ggml-large-v3-turbo-q5_0.bin'))).toBe(true)
  } finally { await app.close() }
})
