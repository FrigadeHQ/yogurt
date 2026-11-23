// A Noise transport session over one socket: JSON app messages in and out, chunked when big, and a rekey of each
// direction after REKEY_BYTES or REKEY_MS. The side that rekeys its sending key first sends {type: "rekey"} under the
// old key, so the other side moves its receiving key at the same message.
import type { Socket } from 'node:net'
import type { CipherState } from './noise'
import { frame, Reassembler, splitMessage } from './frames'

export const REKEY_BYTES = 2 ** 30
export const REKEY_MS = 60 * 60 * 1000

export type Rekey = { bytes: number; ms: number }

export class SecureChannel {
  private readonly reassembler = new Reassembler()
  private sent = 0
  private sentSince: number
  private received = 0
  private closed = false
  /** writes go one at a time, so chunks of two messages never interleave */
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly socket: Socket,
    private readonly tx: CipherState,
    private readonly rx: CipherState,
    private readonly now: () => number = Date.now,
    private readonly rekey: Rekey = { bytes: REKEY_BYTES, ms: REKEY_MS },
  ) {
    this.sentSince = now()
  }

  /**
   * One transport frame in: a whole app message once it has arrived, else null. Throws on anything that doesn't
   * decrypt or parse, or a peer that never rekeys; the caller closes the connection.
   */
  receive(ct: Uint8Array): Record<string, unknown> | null {
    const plain = this.rx.decrypt(ct)
    this.received += ct.length
    // the peer rekeys its own sending side; one that never does is cut off well past the limit
    if (this.received > 2 * this.rekey.bytes) throw new Error('session: peer never rekeyed')
    const msg = this.reassembler.push(plain)
    if (msg?.type === 'rekey' && msg.id === undefined) {
      this.rx.rekey()
      this.received = 0
      return null
    }
    return msg
  }

  /** Sends one app message (chunked when big); resolves once the socket has taken it. */
  send(message: object): Promise<void> {
    const run = this.writing.then(() => this.write(message))
    this.writing = run.catch(() => {})
    return run
  }

  private async write(message: object): Promise<void> {
    if (this.closed) throw new Error('session: closed')
    if (this.sent >= this.rekey.bytes || this.now() - this.sentSince >= this.rekey.ms) {
      await this.put(this.tx.encrypt(new TextEncoder().encode(JSON.stringify({ type: 'rekey' }))))
      this.tx.rekey()
      this.sent = 0
      this.sentSince = this.now()
    }
    for (const part of splitMessage(message)) {
      const ct = this.tx.encrypt(part)
      this.sent += ct.length
      await this.put(ct)
    }
  }

  private put(ct: Uint8Array): Promise<void> {
    if (this.closed || this.socket.destroyed) return Promise.reject(new Error('session: closed'))
    if (this.socket.write(frame(ct))) return Promise.resolve()
    // the phone reads slower than this writes (audio): wait for the socket to drain
    return new Promise((resolve, reject) => {
      const done = (err?: Error) => { this.socket.off('drain', ok); this.socket.off('close', gone); if (err) reject(err); else resolve() }
      const ok = () => done()
      const gone = () => done(new Error('session: closed'))
      this.socket.once('drain', ok)
      this.socket.once('close', gone)
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.tx.wipe()
    this.rx.wipe()
  }
}
