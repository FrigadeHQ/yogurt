import { expect, it, vi } from 'vitest'
import { createDiarizeSchedule } from '../src/main/diarize/afterStop'

const tick = () => new Promise((r) => setTimeout(r, 0))
const deferred = () => {
  let resolve!: () => void, reject!: (e: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup(o: { names?: Promise<void>; finished?: Promise<void>; namesWaitMs?: number; wanted?: () => boolean } = {}) {
  const order: string[] = []
  const schedule = vi.fn(() => { order.push('schedule') })
  const s = createDiarizeSchedule({
    recordingFinished: async () => { order.push('recording') },
    transcriptFinished: async () => { order.push('transcript') },
    namesFinished: () => { order.push('names'); return o.names ?? Promise.resolve() },
    wanted: o.wanted,
    schedule,
    finished: () => { order.push('finished'); return o.finished ?? Promise.resolve() },
    namesWaitMs: o.namesWaitMs ?? 50,
    warn: () => { order.push('warn') },
  })
  return { s, order, schedule }
}

it('runs recording, transcript, names, schedule and job in order, once per start', async () => {
  const { s, order, schedule } = setup()
  await s.start('m1')
  expect(order).toEqual(['recording', 'transcript', 'names', 'schedule', 'finished'])
  await s.start('m1')
  expect(schedule).toHaveBeenCalledOnce()
})

it('does not schedule before the call names arrive', async () => {
  const names = deferred()
  const { s, schedule } = setup({ names: names.promise })
  const run = s.start('m1')
  await tick()
  expect(schedule).not.toHaveBeenCalled()
  names.resolve()
  await run
  expect(schedule).toHaveBeenCalledOnce()
})

it('goes on when the call names fail', async () => {
  const { s, schedule } = setup({ names: Promise.reject(new Error('no permission')) })
  await s.start('m1')
  expect(schedule).toHaveBeenCalledOnce()
})

it('starts anyway when the call names never come', async () => {
  const { s, order } = setup({ names: new Promise(() => {}), namesWaitMs: 20 })
  await s.start('m1')
  expect(order).toEqual(['recording', 'transcript', 'names', 'schedule', 'finished'])
})

it('settles and warns when the job fails, so the notes can go on', async () => {
  const failed = deferred()
  const { s, order } = setup({ finished: failed.promise })
  const run = s.start('m1')
  await tick()
  failed.reject(new Error('nemo failed'))
  await expect(run).resolves.toBeUndefined()
  expect(order.at(-1)).toBe('warn')
})

it('a late wait joins the settled run instead of starting another', async () => {
  const { s, schedule } = setup()
  await s.start('m1')
  await s.wait('m1')
  expect(schedule).toHaveBeenCalledOnce()
})

it('waiting for a meeting that never started resolves', async () => {
  const { s } = setup()
  await expect(s.wait('m2')).resolves.toBeUndefined()
})

it('after forget the meeting can be scheduled again', async () => {
  const { s, schedule } = setup()
  await s.start('m1')
  s.forget('m1')
  await s.start('m1')
  expect(schedule).toHaveBeenCalledTimes(2)
})

it('speaker separation off: the meeting never schedules and the notes wait is over at once', async () => {
  const { s, order, schedule } = setup({ wanted: () => false })
  await s.start('m1')
  expect(schedule).not.toHaveBeenCalled()
  expect(order).toEqual([])
  await expect(s.wait('m1')).resolves.toBeUndefined()
})
