import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEmbedClient, type Fork } from '../src/main/diarize/embed-client'
import { readWavSamples, writeWav } from '../src/main/diarize/wav'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'yogurt-embed-')); dirs.push(d); return d }

/** an in-process worker: answers each request with a vector sized from the range */
function fakeFork(script: (req: { id: number; ranges: Array<{ startMs: number; endMs: number }> }) => unknown): { fork: (p: string) => Fork; sent: unknown[] } {
  const sent: unknown[] = []
  const fork = (_p: string): Fork => {
    const bus = new EventEmitter() as unknown as Fork
    bus.postMessage = (m: unknown) => {
      sent.push(m)
      const req = m as { id: number; ranges: Array<{ startMs: number; endMs: number }> }
      const out = script(req)
      queueMicrotask(() => (bus as unknown as EventEmitter).emit('message', out))
    }
    bus.kill = () => {}
    return bus
  }
  return { fork, sent }
}

describe('embed client', () => {
  it('sends one request and gets normalized vectors in range order', async () => {
    const { fork } = fakeFork((req) => ({ id: req.id, vectors: req.ranges.map(r => new Float32Array([r.endMs - r.startMs, 1])) }))
    const c = createEmbedClient({ workerPath: 'unused.js', modelPath: () => 'm.onnx', fork })
    const out = await c.embed(join(tmp(), 'a.wav'), [{ startMs: 0, endMs: 1000 }, { startMs: 2000, endMs: 3600 }])
    expect(out).toHaveLength(2)
    expect(Math.hypot(...out[0]!)).toBeCloseTo(1)
    expect(out[1]![0]).toBeGreaterThan(out[0]![0])
  })
  it('ranges below the 800 ms minimum come back as holes', async () => {
    const { fork } = fakeFork((req) => ({ id: req.id, vectors: req.ranges.map(r => (r.endMs - r.startMs >= 800 ? new Float32Array([1, 0]) : null)) }))
    const c = createEmbedClient({ workerPath: 'unused.js', modelPath: () => 'm.onnx', fork })
    const out = await c.embed(join(tmp(), 'a.wav'), [{ startMs: 0, endMs: 500 }, { startMs: 0, endMs: 900 }])
    expect(out[0]).toBeUndefined()
    expect(out[1]).toHaveLength(2)
  })
  it('an error response rejects and the next request still works (worker restarts once)', async () => {
    let n = 0
    const { fork } = fakeFork((req) => (++n === 1 ? { id: req.id, error: 'boom' } : { id: req.id, vectors: [new Float32Array([1, 0])] }))
    const c = createEmbedClient({ workerPath: 'unused.js', modelPath: () => 'm.onnx', fork })
    await expect(c.embed(join(tmp(), 'a.wav'), [{ startMs: 0, endMs: 1000 }])).rejects.toThrow('boom')
    await expect(c.embed(join(tmp(), 'a.wav'), [{ startMs: 0, endMs: 1000 }])).resolves.toHaveLength(1)
  })
  it('times out a stuck worker and reports it', async () => {
    const { fork } = fakeFork(() => new Promise(() => {}))
    const c = createEmbedClient({ workerPath: 'unused.js', modelPath: () => 'm.onnx', fork, timeoutMs: 50 })
    await expect(c.embed(join(tmp(), 'a.wav'), [{ startMs: 0, endMs: 1000 }])).rejects.toThrow(/timed out/)
    c.dispose()
  })
  it('settles a call in flight when disposed', async () => {
    const { fork } = fakeFork(() => new Promise(() => {}))
    const c = createEmbedClient({ workerPath: 'unused.js', modelPath: () => 'm.onnx', fork, timeoutMs: 10_000 })
    const flight = c.embed(join(tmp(), 'a.wav'), [{ startMs: 0, endMs: 1000 }])
    await new Promise(r => setTimeout(r, 0))
    c.dispose()
    await expect(flight).rejects.toThrow(/disposed/)
  })
  it('a concurrent call is refused as busy and never kills the worker serving the first', async () => {
    let killCount = 0
    let respond: ((v: { vectors: Float32Array[] }) => void) | undefined
    const fork = (_p: string): Fork => {
      const bus = new EventEmitter() as unknown as Fork
      bus.postMessage = (m: unknown) => {
        const req = m as { id: number }
        respond = (v) => queueMicrotask(() => (bus as unknown as EventEmitter).emit('message', { ...v, id: req.id }))
      }
      bus.kill = () => { killCount++ }
      return bus
    }
    const c = createEmbedClient({ workerPath: 'unused.js', modelPath: () => 'm.onnx', fork, timeoutMs: 5_000 })
    const first = c.embed(join(tmp(), 'a.wav'), [{ startMs: 0, endMs: 1000 }])
    await new Promise(r => setTimeout(r, 0))
    await expect(c.embed(join(tmp(), 'a.wav'), [{ startMs: 0, endMs: 1000 }])).rejects.toThrow(/busy/)
    expect(killCount).toBe(0)
    respond!({ vectors: [new Float32Array([1, 0])] })
    await expect(first).resolves.toHaveLength(1)
    c.dispose()
  })
})

describe('wav helpers', () => {
  it('writeWav/readWavSamples round-trip', () => {
    const f = join(tmp(), 'a.wav')
    writeWav(f, new Float32Array([0, 0.5, -0.5, 1]))
    const { sampleRate, samples } = readWavSamples(f)
    expect(sampleRate).toBe(16000)
    expect([...samples].map(v => Math.round(v * 1000))).toEqual([0, 500, -500, 1000])
  })
})
