import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createProcessingSchedule } from '../src/main/processingSchedule'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-schedule-'))
  dirs.push(dir)
  let now = 100
  let ready = true
  const start = vi.fn(async (_id: string) => true)
  const restart = () => createProcessingSchedule({ file: join(dir, 'processing.json'), now: () => now, ready: () => ready, start })
  return { schedule: restart(), restart, start, time: (at: number) => { now = at }, ready: (value: boolean) => { ready = value } }
}

it('holds only opted-in meetings and waits for a decision', async () => {
  const { schedule, start } = rig()
  expect(schedule.held('live')).toBe(false)
  schedule.hold('saved')
  expect(schedule.held('saved')).toBe(true)
  await schedule.tick()
  expect(start).not.toHaveBeenCalled()
})

it('keeps the chosen time through restart and waits for an idle recording queue', async () => {
  const { schedule, restart, start, time, ready } = rig()
  schedule.hold('saved')
  schedule.choose('saved', 200)
  const reopened = restart()
  await reopened.tick()
  time(200)
  ready(false)
  await reopened.tick()
  expect(start).not.toHaveBeenCalled()
  ready(true)
  await reopened.tick()
  await restart().tick()
  expect(start).toHaveBeenCalledExactlyOnceWith('saved')
  expect(reopened.held('saved')).toBe(false)
})

it('keeps a due job for retry if it cannot start', async () => {
  const { schedule, restart, start } = rig()
  schedule.hold('saved')
  expect(() => schedule.choose('saved', 99)).toThrow()
  schedule.choose('saved', 0)
  start.mockResolvedValueOnce(false)
  await schedule.tick()
  const reopened = restart()
  expect(reopened.held('saved')).toBe(true)
  await reopened.tick()
  expect(reopened.held('saved')).toBe(false)
})
