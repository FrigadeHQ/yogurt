import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs build script helper
import { isWhisperLib } from '../scripts/whisperLibs.mjs'

describe('which files the whisper-server build replaces in resources/bin', () => {
  it('replaces its own ggml and whisper libraries', () => {
    expect(isWhisperLib('libggml-base.so', false)).toBe(true)
    expect(isWhisperLib('libggml-vulkan.so', false)).toBe(true)
    expect(isWhisperLib('libwhisper.so.1', false)).toBe(true)
    expect(isWhisperLib('ggml-cuda.dll', true)).toBe(true)
  })
  it('never removes the notes engine allocator shim (#32) or other helpers', () => {
    expect(isWhisperLib('libyogurt-bigalloc.so', false)).toBe(false)
    expect(isWhisperLib('yogurt-audio', false)).toBe(false)
  })
})
