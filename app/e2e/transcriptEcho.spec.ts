import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

test('the mic copy of the call (an echo) is simply left out of the transcript, with nothing saying so', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-inline-echo-'))
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  let db: DatabaseSync | undefined
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    const id = await app.evaluate(() => (globalThis as any).__fake__.bigMeeting(1)) as string
    db = new DatabaseSync(join(userData, 'yogurt.db'))
    db.prepare('DELETE FROM segments WHERE meeting_id=?').run(id)
    const add = db.prepare('INSERT INTO segments(meeting_id,track,start_ms,end_ms,text,speaker,hidden) VALUES(?,?,?,?,?,?,?)')
    for (const [i, hidden] of [false, true, true, false, true].entries()) add.run(id, hidden ? 'me' : 'them', i * 3000, i * 3000 + 1000, `Speech ${i}`, null, Number(hidden))
    await page.evaluate(id => window.yogurt.nav.go(`/note/${id}`), id)
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await expect(page.getByTestId('transcript-text')).toHaveText(['Speech 0', 'Speech 3'])
    await expect(page.getByTestId('transcript-echo')).toHaveCount(0)
    await expect(page.getByTestId('transcript')).not.toContainText('echoed')
  } finally { db?.close(); await app.close() }
})
