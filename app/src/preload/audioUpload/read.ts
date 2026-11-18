export type AudioSource = { size: number; read: (offset: number, length: number) => Promise<Uint8Array> }
export class AudioFileError extends Error { constructor(readonly kind: 'format' | 'read' = 'read') { super(`Audio ${kind} error`) } }
export function fail(kind: 'format' | 'read' = 'read'): never { throw new AudioFileError(kind) }
export const text = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n))
export const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)
export const u32 = (b: Uint8Array, at: number) => view(b).getUint32(at)
export function u64(b: Uint8Array, at: number): number { const n = Number(view(b).getBigUint64(at)); if (!Number.isSafeInteger(n)) fail(); return n }
/** One read-ahead window, so a long compressed recording does not need one IPC call per frame. */
export class AudioReader {
  private buffer = new Uint8Array(0)
  private offset = 0
  constructor(readonly source: AudioSource, readonly signal: AbortSignal) {}
  async read(at: number, n: number): Promise<Uint8Array> {
    this.signal.throwIfAborted()
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(n) || at < 0 || n < 0 || n > 32 * 1024 ** 2 || at + n > this.source.size) fail()
    if (at < this.offset || at + n > this.offset + this.buffer.length) {
      const length = Math.min(this.source.size - at, Math.max(n, 1024 ** 2))
      this.buffer = new Uint8Array(length); this.offset = at
      for (let i = 0; i < length; i += 1024 ** 2) {
        this.signal.throwIfAborted()
        const bytes = await this.source.read(at + i, Math.min(1024 ** 2, length - i))
        if (bytes.length !== Math.min(1024 ** 2, length - i)) fail()
        this.buffer.set(bytes, i)
      }
    }
    return this.buffer.subarray(at - this.offset, at - this.offset + n)
  }
}
