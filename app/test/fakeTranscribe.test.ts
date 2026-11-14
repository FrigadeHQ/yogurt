import { describe, expect, it } from 'vitest'
import { fakeTranscribe } from '../src/main/asr/fake'
import { createPipeline } from '../src/main/asr/pipeline'
import { afterFinal, joinWords } from '../src/shared/liveWords'

describe('fake transcription', () => {
  it('keeps the complete phrases for uninterrupted fixture audio', async () => {
    for (const [track, startMs, endMs, text] of [
      ['me', 500, 5000, 'Hi, thanks for joining. Can we go over the launch plan for next week?'],
      ['me', 10500, 13100, 'Great. Who is writing the release notes?'],
      ['them', 5200, 10300, 'Sure. The site goes live on Tuesday, and the email goes out on Wednesday morning.'],
      ['them', 13300, 16400, 'She will send a draft by Friday.'],
    ] as const) expect(await fakeTranscribe({ track, startMs, samples: new Float32Array((endMs - startMs) * 16) })).toMatchObject([{ track, startMs, endMs, text }])
  })

  it('gives the other side word times within the phrase, so a finished meeting can be split by voice', async () => {
    const [line] = await fakeTranscribe({ track: 'them', startMs: 5200, samples: new Float32Array(5100 * 16) })
    expect(line.words!.map((w) => w.text).join(' ')).toBe(line.text)
    expect(line.words![0].startMs).toBeGreaterThanOrEqual(5200)
    expect(line.words!.at(-1)!.endMs).toBeLessThanOrEqual(8700)
    for (const w of line.words!) expect(w.endMs).toBeGreaterThan(w.startMs)
  })

  it('does not invent the rest of a phrase in a short pre-pause chunk', async () => {
    expect(await fakeTranscribe({ track: 'me', startMs: 500, samples: new Float32Array(800 * 16) })).toMatchObject([
      { track: 'me', startMs: 500, endMs: 1300, text: 'Hi, thanks for' },
    ])
  })

  it('keeps resumed fixture recordings transcribing at arbitrary later meeting offsets', async () => {
    const [line] = await fakeTranscribe({ track: 'me', startMs: 60000, samples: new Float32Array(1500 * 16) })
    expect(line).toMatchObject({ track: 'me', startMs: 60000, endMs: 61500, text: 'Great. Who is writing the release notes?' })
    // a stand-in beyond the script has no real times to give, so it stays wordless
    expect(line.words).toBeUndefined()
  })

  it('a final from before the pause never duplicates later live words', async () => {
    const samples = Float32Array.from({ length: 12800 }, (_, i) => .2 * Math.sin(i / 7))
    const snapshots: string[] = []
    let emitted!: () => void
    const firstEmission = new Promise<void>(resolve => { emitted = resolve })
    const p = createPipeline({ meetingId: 'm', holdMs: 0, extraWaitMs: 0, transcribe: fakeTranscribe,
      save: () => {}, emitPartial: () => {}, emit: s => {
        const words = p.partials().find(part => part.track === 'me')!.words!
        // The renderer removes the final's live words in the same update that adds its saved line.
        snapshots.push(s.text + ' ' + joinWords(afterFinal(words, s)))
        emitted()
      },
    })
    p.setQuickReads(false)
    p.push('me', 500, samples)
    p.speechPartial('me', { startMs: 0, endMs: 1300, text: 'Hi, thanks for', final: false })
    p.push('me', 3000, samples.subarray(0, 1600))
    p.speechPartial('me', { startMs: 0, endMs: 3300, text: 'Hi, thanks for joining. Can we go over the launch plan', final: false })
    await firstEmission
    expect(snapshots[0]).toBe('Hi, thanks for joining. Can we go over the launch plan')
    await p.finish()
  })
})
