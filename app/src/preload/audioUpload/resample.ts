/** Streaming mono resampling with a low-pass filter; history stays bounded across file chunks. */
export class AudioResampler {
  private data = new Float32Array(0)
  private base = 0
  private frames = 0
  private output = 0
  private readonly table: Float32Array[]
  constructor(private readonly rate: number) {
    if (!Number.isFinite(rate) || rate < 8000 || rate > 192000) throw new Error('Unsupported sample rate')
    const cutoff = Math.min(1, 16000 / rate) * .94
    this.table = Array.from({ length: 256 }, (_, phase) => {
      const taps = new Float32Array(32)
      let sum = 0
      for (let k = 0; k < 32; k++) {
        const x = k - 15 - phase / 256
        const sinc = x === 0 ? cutoff : Math.sin(Math.PI * cutoff * x) / (Math.PI * x)
        taps[k] = sinc * (.42 - .5 * Math.cos(2 * Math.PI * k / 31) + .08 * Math.cos(4 * Math.PI * k / 31)); sum += taps[k]
      }
      return taps.map(x => x / sum)
    })
  }
  push(samples: Float32Array, end = false): Float32Array {
    const data = new Float32Array(this.data.length + samples.length)
    data.set(this.data); data.set(samples, this.data.length)
    this.data = data; this.frames += samples.length
    const count = Math.max(this.output, Math.floor((end ? this.frames : Math.max(0, this.frames - 17)) * 16000 / this.rate))
    const out = new Float32Array(count - this.output)
    for (let i = 0; this.output < count; this.output++, i++) {
      const at = this.output * this.rate / 16000, first = Math.floor(at), taps = this.table[Math.min(255, Math.floor((at - first) * 256))]
      let value = 0
      for (let k = 0; k < 32; k++) value += (data[first - 15 + k - this.base] ?? 0) * taps[k]
      out[i] = Math.max(-1, Math.min(1, value))
    }
    const keep = Math.max(this.base, Math.floor(this.output * this.rate / 16000) - 16)
    this.data = data.slice(keep - this.base); this.base = keep
    return out
  }
}
