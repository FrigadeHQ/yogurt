import { readFileSync, writeFileSync } from 'node:fs'

/** 16 kHz mono 16-bit PCM wav, for the diarizer and the embedding worker (mirrors asr/transcribe.ts wavBytes) */
export function writeWav(path: string, samples: Float32Array, sampleRate = 16000): void {
  const n = samples.length * 2
  const b = Buffer.alloc(44 + n)
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8, 'ascii')
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36, 'ascii'); b.writeUInt32LE(n, 40)
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2)
  writeFileSync(path, b)
}

/** reads what writeWav and `yogurt-audio decode` write: PCM16 mono */
export function readWavSamples(path: string): { sampleRate: number; samples: Float32Array } {
  const b = readFileSync(path)
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a wav')
  const sampleRate = b.readUInt32LE(24)
  const start = b.indexOf('data', 12, 'ascii') + 8
  const n = (b.length - start) >> 1
  const samples = new Float32Array(n)
  for (let i = 0; i < n; i++) samples[i] = b.readInt16LE(start + i * 2) / 32768
  return { sampleRate, samples }
}
