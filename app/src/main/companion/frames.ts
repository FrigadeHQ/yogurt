// The wire under the iPhone companion: every frame is a 2-byte big-endian length then that many bytes (a pairing JSON
// message, a Noise handshake message, or a Noise transport message). App messages bigger than CHUNK_AT bytes go as
// several transport messages {chunk: base64 of the next slice of the message's UTF-8 JSON, of: how many}, in order.
// The phone's sync client (YogurtKit) speaks exactly this.

export const MAX_FRAME = 65535
/** an app message longer than this is split */
export const CHUNK_AT = 60000
/** bytes of the message in each chunk: base64 makes 44000 into 58668, under CHUNK_AT with the JSON around it */
export const CHUNK_BYTES = 44000
/** one reassembled message is at most this big */
export const MAX_MESSAGE = 64 * 1024 * 1024

export function frame(payload: Uint8Array): Buffer {
  if (payload.length > MAX_FRAME) throw new Error('frame: too big')
  const out = Buffer.alloc(2 + payload.length)
  out.writeUInt16BE(payload.length, 0)
  out.set(payload, 2)
  return out
}

/**
 * Cuts a byte stream into frames. Holds at most one unfinished frame, so a peer can't make it buffer more, and copies
 * each byte once however finely it trickles in.
 */
export class FrameReader {
  private head = Buffer.alloc(2)
  private headLen = 0
  private body: Buffer | null = null
  private filled = 0

  push(data: Buffer): Uint8Array[] {
    const out: Uint8Array[] = []
    let at = 0
    while (at < data.length) {
      if (!this.body) {
        const n = Math.min(2 - this.headLen, data.length - at)
        data.copy(this.head, this.headLen, at, at + n)
        this.headLen += n; at += n
        if (this.headLen < 2) break
        this.body = Buffer.alloc(this.head.readUInt16BE(0))
        this.filled = 0
        if (!this.body.length) { out.push(new Uint8Array(0)); this.body = null; this.headLen = 0; continue }
      }
      const n = Math.min(this.body.length - this.filled, data.length - at)
      data.copy(this.body, this.filled, at, at + n)
      this.filled += n; at += n
      if (this.filled === this.body.length) {
        out.push(new Uint8Array(this.body.buffer, this.body.byteOffset, this.body.length))
        this.body = null; this.headLen = 0
      }
    }
    return out
  }

  /** bytes of a frame that hasn't fully arrived */
  get waiting(): number { return this.headLen + (this.body ? this.filled : 0) }
}

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true })

/** One app message as the plaintexts to encrypt: itself, or its chunks. */
export function splitMessage(message: object): Uint8Array[] {
  const bytes = enc.encode(JSON.stringify(message))
  if (bytes.length <= CHUNK_AT) return [bytes]
  if (bytes.length > MAX_MESSAGE) throw new Error('frames: message too big')
  const of = Math.ceil(bytes.length / CHUNK_BYTES)
  const parts: Uint8Array[] = []
  for (let i = 0; i < of; i++) {
    const chunk = Buffer.from(bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)).toString('base64')
    parts.push(enc.encode(JSON.stringify({ chunk, of })))
  }
  return parts
}

export function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(dec.decode(bytes))
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Puts chunked messages back together; throws on anything malformed or too big (the connection then closes). */
export class Reassembler {
  private parts: Buffer[] = []
  private of = 0
  private size = 0

  constructor(private readonly max = MAX_MESSAGE) {}

  /** A whole message once it has arrived, else null. */
  push(plain: Uint8Array): Record<string, unknown> | null {
    const v = parseJson(plain)
    if (!isObject(v)) throw new Error('frames: not an object')
    if (!('chunk' in v)) {
      if (this.of) throw new Error('frames: message inside a chunked one')
      return v
    }
    const { chunk, of } = v
    if (typeof chunk !== 'string' || !Number.isSafeInteger(of) || (of as number) < 2 || (of as number) > Math.ceil(this.max / CHUNK_BYTES)) throw new Error('frames: bad chunk')
    if (this.of && of !== this.of) throw new Error('frames: chunk count changed')
    this.of = of as number
    const part = Buffer.from(chunk, 'base64')
    this.size += part.length
    if (this.size > this.max) throw new Error('frames: message too big')
    this.parts.push(part)
    if (this.parts.length < this.of) return null
    const whole = Buffer.concat(this.parts)
    this.parts = []; this.of = 0; this.size = 0
    const msg = parseJson(whole)
    if (!isObject(msg) || 'chunk' in msg) throw new Error('frames: bad chunked message')
    return msg
  }
}
