import { describe, expect, it } from 'vitest'
import { hearsClip } from '../src/main/asr/speedCheck'

// a fake whisper-server answer with these words
const answer = (text: string): typeof fetch => (async () => new Response(JSON.stringify({ detected_language: 'english', detected_language_probability: 0.99, segments: text ? [{ start: 0, end: 3, text }] : [] }))) as unknown as typeof fetch
const speech = new Float32Array(16000 * 4).map((_, i) => Math.sin(i / 8) * 0.3)

// #92, #76: some graphics cards load whisper and answer with nothing
describe('does whisper on the graphics card hear the clip', () => {
  it('words back: yes', async () => {
    expect(await hearsClip('http://127.0.0.1:1', speech, answer(' The quick brown fox jumps'))).toBe(true)
  })
  it('nothing, or a lone word, back: no', async () => {
    expect(await hearsClip('http://127.0.0.1:1', speech, answer(''))).toBe(false)
    expect(await hearsClip('http://127.0.0.1:1', speech, answer(' you'))).toBe(false)
  })
})
