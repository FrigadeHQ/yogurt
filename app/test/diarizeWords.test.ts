import { describe, expect, it, vi } from 'vitest'
import { createPipeline } from '../src/main/asr/pipeline'
import type { Chunk } from '../src/main/asr/chunker'

const RATE = 16000
// voiced tone like test/pipeline.test.ts's: silent samples never pass the chunker's voice gate, so whisper would never see them
const chunk = (track: 'me' | 'them', startMs: number): Chunk => ({ track, startMs, samples: Float32Array.from({ length: RATE }, (_, i) => 0.3 * Math.sin(i / 10)), clearMs: 1600 })

describe('pipeline saves words for re-splitting', () => {
  it('saves whisper\'s words on them lines, and none on me lines', async () => {
    const save = vi.fn()
    const p = createPipeline({ meetingId: 'm1', save, emit: () => {}, holdMs: 0, extraWaitMs: 0,
      transcribe: async (c) => c.track === 'them'
        ? [{ track: 'them', startMs: 0, endMs: 2000, text: 'hello there', words: [{ text: 'hello', startMs: 0, endMs: 800 }, { text: 'there', startMs: 900, endMs: 2000 }] }]
        : [{ track: 'me', startMs: 0, endMs: 1000, text: 'hi', words: [{ text: 'hi', startMs: 0, endMs: 1000 }] }] })
    p.push('them', 0, chunk('them', 0).samples)
    p.push('me', 3000, chunk('me', 3000).samples)
    await p.finish()
    const segs = save.mock.calls.flat(2) as Array<{ track: string; words?: unknown[] }>
    expect(segs.find(s => s.track === 'them')!.words).toEqual([{ text: 'hello', startMs: 0, endMs: 800 }, { text: 'there', startMs: 900, endMs: 2000 }])
    expect(segs.find(s => s.track === 'me')!.words).toBeUndefined()
  })
  it('saves a them line without words as a line without words', async () => {
    const save = vi.fn()
    const p = createPipeline({ meetingId: 'm1', save, emit: () => {}, transcribe: async () => [{ track: 'them', startMs: 0, endMs: 500, text: 'ok' }] })
    p.push('them', 0, chunk('them', 0).samples)
    await p.finish()
    expect((save.mock.calls.flat(2) as unknown[])[0]).not.toHaveProperty('words')
  })
})
