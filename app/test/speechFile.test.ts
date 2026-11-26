import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { checkSpeechFile, insideDir } from '../src/main/speechFile'

const dir = mkdtempSync(join(tmpdir(), 'yogurt-speech-file-'))
/** a file with whisper.cpp's header: the magic, then n_vocab, n_audio_ctx … n_mels, ftype */
const file = (name: string, magic: number, hparams: number[], bytes = 4096) => {
  const b = Buffer.alloc(bytes)
  b.writeUInt32LE(magic, 0)
  hparams.forEach((v, i) => b.writeInt32LE(v, 4 + i * 4))
  writeFileSync(join(dir, name), b)
  return join(dir, name)
}
const GGML = 0x67676d6c
const largeV3 = [51866, 1500, 1280, 20, 32, 448, 1280, 20, 32, 128, 1]
const tiny = [51865, 1500, 384, 6, 4, 448, 384, 6, 4, 80, 1]

it("takes a whisper.cpp model's header, with 80 or 128 mel bands", () => {
  expect(checkSpeechFile(file('large-v3.bin', GGML, largeV3))).toEqual({ ok: true, bytes: 4096 })
  expect(checkSpeechFile(file('tiny.bin', GGML, tiny))).toEqual({ ok: true, bytes: 4096 })
})

it('refuses GGUF, another ggml model, a short file, and what it cannot read', () => {
  // "GGUF" as whisper-server would read it: it does not load these
  expect(checkSpeechFile(file('model.gguf', 0x46554747, largeV3))).toEqual({ ok: false, error: 'not-whisper' })
  // ggml, but not shaped like Whisper (a language model's hparams)
  expect(checkSpeechFile(file('llama.bin', GGML, [32000, 4096, 256, 32, 32, 128, 0, 0, 0, 0, 1]))).toEqual({ ok: false, error: 'not-whisper' })
  expect(checkSpeechFile(file('short.bin', GGML, [51866, 1500], 12))).toEqual({ ok: false, error: 'not-whisper' })
  expect(checkSpeechFile(join(dir, 'missing.bin'))).toEqual({ ok: false, error: 'unreadable' })
  expect(checkSpeechFile(dir)).toEqual({ ok: false, error: 'unreadable' })
})

it.skipIf(process.platform === 'win32')('refuses a named pipe without waiting for something to write into it', () => {
  const fifo = join(dir, 'pipe.bin')
  execFileSync('mkfifo', [fifo])
  expect(checkSpeechFile(fifo)).toEqual({ ok: false, error: 'unreadable' })
})

it("tells a file in Yogurt's models folder, also through a link, from one outside it", () => {
  const models = join(dir, 'models'), asr = join(models, 'asr')
  mkdirSync(asr, { recursive: true })
  const inside = file('models/asr/ggml-small.bin', GGML, tiny)
  expect(insideDir(inside, models)).toBe(true)
  expect(insideDir(file('outside.bin', GGML, tiny), models)).toBe(false)
  expect(insideDir(models, models)).toBe(false)
  expect(insideDir(join(dir, 'models-other', 'x.bin'), models)).toBe(false)
  if (process.platform !== 'win32') {
    symlinkSync(inside, join(dir, 'link.bin'))
    expect(insideDir(join(dir, 'link.bin'), models)).toBe(true)
  }
})
