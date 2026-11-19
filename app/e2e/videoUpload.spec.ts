import { _electron as electron, expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')

for (const ext of ['mov', 'mp4']) test(`@everywhere a screen recording (.${ext}) uploads as its audio, decoded past the video track`, async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-video-upload-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    // the file the person picks: a real AVFoundation recording, 64×64 H.264 and 2.6 s of speech as AAC
    const file = join(import.meta.dirname, '../test/fixtures', `screen-recording.${ext}`)
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog }, file)
    const picked = await page.evaluate(() => window.yogurt.audioUpload.pick())
    expect(picked?.title).toBe('screen-recording')
    const durationMs = await page.evaluate(token => window.yogurt.audioUpload.inspect(token), picked!.token)
    expect(Math.round(durationMs / 100)).toBe(26)
    const meetingId = await page.evaluate(({ token, at }) => new Promise<string>((resolve, reject) => {
      const off = window.yogurt.audioUpload.onStatus((t, s) => {
        if (t !== token) return
        if (s.phase === 'done' && s.meetingId) { off(); resolve(s.meetingId) }
        if (s.phase === 'error') { off(); reject(new Error(s.error)) }
      })
      void window.yogurt.audioUpload.start(token, 'Screen recording', at)
    }), { token: picked!.token, at: Date.now() - 60_000 })
    // 16 kHz mono 16-bit WAV for transcription: 2.6 s of samples after the header
    const wav = join(userData, 'meetings', meetingId, 'them.wav')
    expect(existsSync(wav)).toBe(true)
    expect(Math.round((statSync(wav).size - 44) / 2 / 16000 * 10)).toBe(26)
    expect(await page.evaluate(id => window.yogurt.meetings.get(id).then(m => m && { source: m.source, title: m.title }), meetingId)).toEqual({ source: 'audio-file', title: 'Screen recording' })
  } finally { await app.close() }
})
