import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const transcript = 'Ana entrega a revisão do contrato até sexta-feira. Bruno valida o ambiente na segunda-feira. A implantação está aprovada para terça-feira, às nove horas.'

test('regenerates the same Portuguese transcript with E4B and 26B and returns to Auto', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-summary-model-'))
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, YOGURT_FAKE_LLM_MS: '2',
  } })
  const requests = () => app.evaluate(async () => {
    const { notes, summaryModels } = (globalThis as unknown as { __fake__: { prompts(): { notes: string[]; summaryModels: string[] } } }).__fake__.prompts()
    return notes.map((prompt, i) => ({ prompt, model: summaryModels[i] }))
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(o: { n: number; clean: boolean }): void } }).__fake__.manyMeetings({ n: 1, clean: true }))
    const db = new DatabaseSync(join(userData, 'yogurt.db'))
    let id: string
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      id = String(db.prepare("SELECT id FROM meetings WHERE state = 'done' LIMIT 1").get()?.id)
      db.prepare('UPDATE meetings SET language = ? WHERE id = ?').run('portuguese', id)
      db.prepare('DELETE FROM segments WHERE meeting_id = ?').run(id)
      db.prepare('INSERT INTO segments (meeting_id, track, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)')
        .run(id, 'me', 0, 8000, transcript)
    } finally { db.close() }
    await page.evaluate(id => window.yogurt.nav.go('/note/' + id), id)
    const regenerate = async (choice?: string) => {
      const before = (await requests()).length
      await page.getByTestId('note-menu-button').click()
      await page.getByTestId('note-write-again').click()
      const select = page.getByTestId('note-regenerate-model')
      await expect(select).toHaveValue('')
      if (choice) await select.selectOption(choice)
      await page.getByTestId('note-write-again-confirm').click()
      const matching = async () => (await requests()).slice(before).filter(request => request.prompt.includes(transcript))
      await expect.poll(async () => (await matching()).length).toBeGreaterThan(0)
      await expect.poll(() => page.evaluate(async id => (await window.yogurt.notes.get(id)).status, id)).toBe('done')
      return (await matching())[0].model
    }
    const automatic = await regenerate()
    expect(automatic).toMatch(/gemma.*\.gguf/i)
    expect(await regenerate('gemma-4-e4b')).toMatch(/-E4B_/i)
    expect(await regenerate('gemma-4-26b-a4b')).toMatch(/-26B_/i)
    expect(await regenerate()).toBe(automatic)
    expect((await page.evaluate(id => window.yogurt.transcript.get(id), id)).map(segment => segment.text)).toEqual([transcript])
  } finally { await app.close() }
})
