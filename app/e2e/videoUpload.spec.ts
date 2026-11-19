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

// Mac: the screen is read by Vision through yogurt-audio (screen-text)
test('a slides video adds what its screen showed as Screen lines, and its copy follows What Yogurt keeps', async () => {
  test.skip(process.platform !== 'darwin', 'screen text is read on a Mac')
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-screen-text-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    // two slides at 640×360, "Q3 roadmap / Launch on Tuesday" then "Budget 40,000 EUR / Owner: Ann Lee", over 2.6 s of speech
    const file = join(import.meta.dirname, '../test/fixtures/slides.mov')
    const upload = async () => {
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog }, file)
      const picked = (await page.evaluate(() => window.yogurt.audioUpload.pick()))!
      return page.evaluate(token => new Promise<string>((resolve, reject) => {
        const off = window.yogurt.audioUpload.onStatus((t, s) => {
          if (t !== token) return
          if (s.phase === 'done' && s.meetingId) { off(); resolve(s.meetingId) }
          if (s.phase === 'error') { off(); reject(new Error(s.error)) }
        })
        void window.yogurt.audioUpload.start(token, 'Slides', Date.now() - 60_000)
      }), picked.token)
    }
    const id = await upload()
    expect(existsSync(join(userData, 'meetings', id, 'video.mov'))).toBe(true)
    const screen = (await page.evaluate(id => window.yogurt.transcript.get(id), id)).filter(l => l.speaker === '\u001fscreen').map(l => [l.startMs, l.text])
    expect(screen).toEqual([[0, 'Q3 roadmap\nLaunch on Tuesday'], [2000, 'Budget 40,000 EUR\nOwner: Ann Lee']])
    await page.evaluate(id => window.yogurt.nav.go(`/note/${id}`), id)
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await expect(page.getByTestId('transcript-turn').filter({ hasText: 'Q3 roadmap' }).getByTestId('transcript-who')).toHaveText('Screen')
    // Don't keep it: the screen is still read, the video is not copied
    await page.evaluate(() => window.yogurt.settings.setRetention('video', 0))
    const second = await upload()
    expect(existsSync(join(userData, 'meetings', second, 'video.mov'))).toBe(false)
    expect((await page.evaluate(id => window.yogurt.transcript.get(id), second)).some(l => l.text.includes('Owner: Ann Lee'))).toBe(true)
  } finally { await app.close() }
})
