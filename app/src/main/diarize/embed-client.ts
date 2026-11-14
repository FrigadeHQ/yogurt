import { utilityProcess } from 'electron'

/**
 * Main-process client for the embedding worker: lazy start, one request in flight, one restart,
 * then profiles are skipped for the session. Never blocks the interface.
 */
export type Fork = { on(event: 'message', fn: (m: unknown) => void): unknown; postMessage(m: unknown): void; kill(): void }
export type EmbedRequest = { id: number; wav: string; model: string; ranges: Array<{ startMs: number; endMs: number }> }
export type EmbedResponse = { id: number; vectors?: Array<Float32Array | null>; error?: string }

export type EmbedClient = {
  embed(wav: string, ranges: Array<{ startMs: number; endMs: number }>): Promise<Array<Float32Array | undefined>>
  dispose(): void
}

const IDLE_MS = 5 * 60_000

/** unit length, whatever the worker returned — the contract is normalized vectors, one per range */
const normalize = (v: Float32Array): Float32Array => {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const n = Math.sqrt(sum) || 1
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

export function createEmbedClient(p: { workerPath: string; modelPath: () => string | undefined; fork?: (workerPath: string) => Fork; timeoutMs?: number }): EmbedClient {
  const fork = p.fork ?? ((workerPath: string) => utilityProcess.fork(workerPath, [], { serviceName: 'Yogurt Voices' }) as unknown as Fork)
  let proc: Fork | undefined
  let restarted = false
  let nextId = 1
  let inflight: { id: number; resolve: (v: Array<Float32Array | null>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | undefined
  let idleTimer: NodeJS.Timeout | undefined

  const close = () => { proc?.kill(); proc = undefined }
  const armIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(close, IDLE_MS) }

  const open = (): Fork => {
    if (proc) return proc
    const child = fork(p.workerPath)
    child.on('message', (m: unknown) => {
      const r = m as EmbedResponse
      if (!inflight || r.id !== inflight.id) return
      clearTimeout(inflight.timer)
      const f = inflight; inflight = undefined
      if (r.error) { if (!restarted) { restarted = true; close(); f.reject(new Error('embedding worker: ' + r.error)); return } f.reject(new Error('embedding worker: ' + r.error)); return }
      f.resolve(r.vectors ?? [])
    })
    proc = child
    return child
  }

  const ask = (req: EmbedRequest): Promise<Array<Float32Array | null>> => new Promise((resolve, reject) => {
    if (inflight) { reject(new Error('embedding worker is busy')); return }
    const timer = setTimeout(() => {
      const f = inflight; inflight = undefined
      close()
      f?.reject(new Error(`embedding worker timed out after ${p.timeoutMs ?? 30_000} ms`))
    }, p.timeoutMs ?? 30_000)
    inflight = { id: req.id, resolve, reject, timer }
    open().postMessage(req)
  })

  return {
    async embed(wav, ranges) {
      const model = p.modelPath()
      if (!model) throw new Error('speaker model is not downloaded yet')
      if (!ranges.length) return []
      clearTimeout(idleTimer)
      const id = nextId++
      let vectors: Array<Float32Array | null>
      try { vectors = await ask({ id, wav, model, ranges }) }
      catch (e) {
        if (restarted) throw e
        restarted = true; close()
        vectors = await ask({ id: nextId++, wav, model, ranges })
      }
      armIdle()
      return ranges.map((_, i) => { const v = vectors[i]; return v ? normalize(v) : undefined })
    },
    dispose() { clearTimeout(idleTimer); inflight && clearTimeout(inflight.timer); inflight = undefined; close() },
  }
}
