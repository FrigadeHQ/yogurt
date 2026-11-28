import { expect, it } from 'vitest'
import { earlierStep } from '../src/renderer/src/autoExportProgress'

it('a progress update arriving after the save finished does not undo "saved"', () => {
  // invoke's reply and webContents.send events are not ordered against each other
  let s = earlierStep(null, { start: true })
  s = earlierStep(s, { progress: { done: 1, total: 2 } })
  s = earlierStep(s, { finished: true })
  s = earlierStep(s, { progress: { done: 2, total: 2 } })
  expect(s).toBe('done')
})

it('shows progress while saving, and nothing once it failed or was never started', () => {
  expect(earlierStep(earlierStep(null, { start: true }), { progress: { done: 1, total: 3 } })).toEqual({ done: 1, total: 3 })
  expect(earlierStep(null, { progress: { done: 1, total: 3 } })).toBeNull()
  expect(earlierStep({ done: 1, total: 3 }, { finished: false })).toBeNull()
})
