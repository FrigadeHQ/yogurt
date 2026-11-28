import { utilityProcess, type UtilityProcess } from 'electron'
import { outOfGraphicsMemory, type EngineEvent, type EngineMessage, type EngineRequest } from '../shared/engine-protocol'
export { outOfGraphicsMemory }
import type { GpuProbe } from './hardware'

export class InsufficientMemoryError extends Error { name = 'InsufficientMemoryError' }
/** Windows and Linux: the graphics card took too long (or crashed), so the engine starts again without it; try once more */
export class GraphicsGaveUpError extends Error { name = 'GraphicsGaveUpError' }
/** the card ran out of memory: the engine starts again with fewer layers on it, each time down to the processor (#165) */
export class GraphicsFullError extends GraphicsGaveUpError { name = 'GraphicsFullError' }

/** after the card ran out of memory with this many layers on it: the most for the next try, 0 for the processor alone */
export const fewerLayers = (layers: number): number => layers >= 8 ? Math.floor(layers / 2) : 0
/** the most layers a model may put on the card (kept in settings, so the next launch doesn't run out again) */
export type GpuLayers = { model: string; layers: number }
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path

/**
 * Off a Mac, how long a step may take before the graphics card counts as stuck (a hang, not a crash: some drivers do).
 * Loading includes reading the weights from disk; the first word includes reading a long meeting in.
 */
export const WATCH = { probeMs: 90_000, loadMs: 5 * 60_000, firstTokenMs: 5 * 60_000, cpuLoadMs: 15 * 60_000, cpuFirstTokenMs: 30 * 60_000 }
type Limits = typeof WATCH

/** Vulkan's "the graphics card was reset" (a driver hang): the process that saw it can never use the card again */
export const deviceLost = (message: string): boolean => /ErrorDeviceLost|VK_ERROR_DEVICE_LOST/i.test(message)

/**
 * Linux (#32): Electron's own allocator traps (SIGILL, code 132) on one allocation over 2 GiB, and llama.cpp makes one
 * when the model runs on the processor (its repacked weights, a big context). libyogurt-bigalloc.so (native/bigalloc)
 * sends those to mmap instead. Only the notes engine gets it, and only when it was shipped.
 */
export const SHIM = 'libyogurt-bigalloc.so'
export const engineShim = (platform: string, candidates: string[], exists: (p: string) => boolean): string | undefined =>
  // LD_PRELOAD splits on spaces and colons, so a path with one would never load
  platform === 'linux' ? candidates.find((p) => !/[\s:]/.test(p) && exists(p)) : undefined

/** what node-llama-cpp runs the model with: its own pick (CUDA first where it finds CUDA), or Vulkan */
export type Backend = 'auto' | 'vulkan'

/**
 * Windows and Linux: the backends to check the graphics with, in order (#32). Inside Electron node-llama-cpp can't test
 * a build before loading it (patches/), so a CUDA build that won't start is kept and finds no card, where plain Node
 * would move on to Vulkan. The one that found the card last time goes first; a NODE_LLAMA_CPP_GPU set by hand is left alone.
 */
export const backendOrder = (platform: string, env: Record<string, string | undefined>, saved?: Backend): Backend[] =>
  platform === 'darwin' || env.NODE_LLAMA_CPP_GPU ? ['auto'] : saved === 'vulkan' ? ['vulkan', 'auto'] : ['auto', 'vulkan']

export type ChatRequest = { messages: EngineMessage[]; maxTokens?: number; thoughtBudget?: number; /** instead of the family's sampling temperature */ temperature?: number }

export interface Engine {
  load(modelPath: string, contextSize: number, minContext: number): Promise<{ contextSize: number }>
  unload(): Promise<void>
  count(texts: string[]): Promise<number[]>
  chat(req: ChatRequest, onToken: (text: string) => void, signal?: AbortSignal): Promise<string>
  /** reads messages in without answering, the last one as the start of a prompt to come (tokens read) */
  preload(messages: EngineMessage[], signal?: AbortSignal): Promise<number>
  /** each text as the embedding model's vector (loaded on first use, kept until unloadEmbed) */
  embed(modelPath: string, texts: string[]): Promise<number[][]>
  unloadEmbed(): Promise<void>
  /** the engine process died (not on dispose): what it had loaded is gone */
  onExit(cb: () => void): void
  dispose(): void
}

/** load: checking the graphics or loading a model, where a graphics driver can crash the engine */
type Pending = { resolve(v: unknown): void; reject(e: Error): void; onToken?: (t: string) => void; load?: boolean; model?: boolean; timer?: NodeJS.Timeout }
type Req = EngineRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never

/** The notes model's worker (src/engine/worker.ts) in an Electron utility process, started on first use */
export class UtilityEngine implements Engine {
  private proc: UtilityProcess | undefined
  private nextId = 1
  private pending = new Map<number, Pending>()
  private exitListeners: (() => void)[] = []
  private disposed = false
  /**
   * Windows and Linux (gpuFallback): some graphics drivers crash the engine as it checks the card or loads a model.
   * After a crash like that it starts without the graphics card: slower, but it works. A Mac never does.
   */
  private cpuOnly = false
  /** a model loaded fine in this process, so a later crash isn't the graphics card failing to start */
  private loaded = false

  private limits: Limits
  private backend: Backend
  /** the cap on layers after the card ran out of memory (#165), and what the model in this process put on the card */
  private gpuLayers: GpuLayers | undefined
  private onCard: GpuLayers | undefined
  /** the model being loaded or last loaded */
  private model = ''

  /**
   * cpuCrashes (Linux without the shim): the engine dies on the processor alone (code 132: Electron's allocator refuses
   * llama.cpp's single > 2 GiB weight buffer), so a lost graphics card starts the engine again on the card, not without it.
   * preload: the shim that prevents that crash (engineShim), put in the engine's LD_PRELOAD.
   * backends (backendOrder): what probe() checks the graphics with until one finds a card; onBackend: the one that did.
   * gpuLayers: the cap kept from an earlier launch; onGpuLayers: a new one, after the card ran out of memory (#165).
   */
  constructor(private workerPath: string, private opts: { gpuFallback?: boolean; cpuCrashes?: boolean; preload?: string; backends?: Backend[]; onBackend?: (b: Backend) => void; gpuLayers?: GpuLayers; onGpuLayers?: (l: GpuLayers) => void } & Partial<Limits> = {}) {
    this.limits = { ...WATCH, ...opts }
    this.backend = opts.backends?.[0] ?? 'auto'
    this.gpuLayers = opts.gpuLayers
  }

  /** the cap for this model, if it ran out of memory before */
  private capFor(model: string) { return this.gpuLayers?.model === model ? this.gpuLayers.layers : undefined }

  /**
   * The card ran out of memory (#165: a 4 GB card given every layer and a 32k context): the next engine gets half the
   * layers, then the processor alone, and that is kept. On the processor already, there is nothing to step down from.
   */
  private outOfMemory(message: string): boolean {
    if (!this.opts.gpuFallback || this.cpuOnly || !this.model || !outOfGraphicsMemory(message)) return false
    const was = this.onCard?.model === this.model ? this.onCard.layers : undefined
    if (was === 0 || this.capFor(this.model) === 0) return false
    // a load that still ran out (its own fewer layers did not help): the processor
    this.gpuLayers = { model: this.model, layers: was === undefined ? 0 : fewerLayers(was) }
    console.warn(`notes engine: the graphics card ran out of memory (${message}); starting it again ${this.gpuLayers.layers ? `with at most ${this.gpuLayers.layers} layers on it` : 'without the graphics card'}`)
    this.opts.onGpuLayers?.(this.gpuLayers)
    return true
  }

  /** a different backend means a fresh engine process, and a fresh try on the card */
  private use(b: Backend) {
    if (b === this.backend) return
    this.backend = b
    this.cpuOnly = false
    if (this.proc) this.drop(() => new Error('The notes engine was restarted'))
  }

  /**
   * Windows and Linux only: a step that takes far too long. On the graphics card the engine is stopped and the next
   * try runs without it (GraphicsGaveUpError); without it the step fails plainly, so nothing waits forever.
   */
  private watch(id: number, step: string, gpuMs: number, cpuMs: number) {
    const p = this.pending.get(id)
    if (!p || !this.opts.gpuFallback) return
    clearTimeout(p.timer)
    const onCard = !this.cpuOnly, ms = onCard ? gpuMs : cpuMs
    p.timer = setTimeout(() => {
      if (this.pending.get(id) !== p) return
      if (onCard) this.cpuOnly = true
      console.warn(`notes engine: ${step} took over ${Math.round(ms / 1000)} s ${onCard ? 'on the graphics card; starting it again without it' : 'without the graphics card; giving up'}`)
      this.drop(() => onCard ? new GraphicsGaveUpError(`The graphics card took too long (${step})`) : new Error(`The notes model took too long (${step})`))
    }, ms)
  }

  /** stops a stuck engine at once: what it had loaded is gone (onExit), everything waiting on it fails */
  private drop(error: () => Error) {
    const proc = this.proc
    this.proc = undefined
    this.onCard = undefined
    const waiting = [...this.pending.values()]
    this.pending.clear()
    proc?.kill()
    for (const cb of this.exitListeners) cb()
    for (const p of waiting) { clearTimeout(p.timer); p.reject(error()) }
  }

  private ensure(): UtilityProcess {
    if (this.proc) return this.proc
    const { preload } = this.opts
    const vulkan = this.backend === 'vulkan'
    const env = preload || this.cpuOnly || vulkan ? {
      ...process.env,
      ...(preload ? { LD_PRELOAD: [preload, process.env.LD_PRELOAD].filter(Boolean).join(':') } : {}),
      // off wins: without the card is without it, whichever build
      ...(this.cpuOnly ? { YOGURT_ENGINE_GPU: 'off' } : vulkan ? { YOGURT_ENGINE_GPU: 'vulkan' } : {}),
    } : undefined
    const proc = utilityProcess.fork(this.workerPath, [], { serviceName: 'Yogurt Notes', ...(env ? { env } : {}) })
    this.loaded = false
    proc.on('message', (e: EngineEvent) => {
      if (e.type === 'log') { console[e.level]('NOTES', e.text); return }
      const p = this.pending.get(e.id)
      if (!p) return
      // thinking is never shown: only the answer streams. Any token (thinking too) means the model is writing.
      if (e.type === 'token') { if (p.timer) { clearTimeout(p.timer); p.timer = undefined; console.info('NOTES', 'first words') } if (!e.thought) p.onToken?.(e.text); return }
      if (e.type === 'timing') { console.info('TIMING', e.text); return }
      this.pending.delete(e.id)
      clearTimeout(p.timer)
      if (e.type === 'result' && p.model) this.loaded = true
      if (e.type === 'result') p.resolve(e.data)
      else if (this.outOfMemory(e.message)) {
        // a fresh process: one that ran out may not give the memory back
        this.pending.set(e.id, p)
        this.drop(() => new GraphicsFullError(`The graphics card ran out of memory: ${e.message}`))
      } else if (this.opts.gpuFallback && deviceLost(e.message)) {
        // the card was reset under it: a fresh engine (on the processor, where that works) is the only way on
        if (!this.opts.cpuCrashes) this.cpuOnly = true
        console.warn(`notes engine: the graphics card was lost (${e.message}); starting it again${this.cpuOnly ? ' without the graphics card' : ''}`)
        this.pending.set(e.id, p)
        this.drop(() => new GraphicsGaveUpError(`The graphics card was lost: ${e.message}`))
      } else p.reject(e.code === 'OOM' ? new InsufficientMemoryError(e.message) : new Error(e.message))
    })
    proc.on('exit', (code: number) => {
      // stopped as stuck (drop): already dealt with
      if (this.proc !== proc) return
      this.proc = undefined
      this.onCard = undefined
      const loading = !!this.opts.gpuFallback && !this.loaded && [...this.pending.values()].some((p) => p.load)
      const starting = loading && !this.cpuOnly
      // it died starting without the card too (Linux, code 132): staying off the card would only crash again, so the
      // next try uses the card, with a fresh look at it (the first look sometimes finds no card at all)
      const backToCard = loading && this.cpuOnly
      if (starting) this.cpuOnly = true
      if (backToCard) this.cpuOnly = false
      if (!this.disposed) console.error(`notes engine stopped (code ${code})${starting ? '; starting it again without the graphics card' : backToCard ? ' without the graphics card too; the next try uses the card again' : ''}`)
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(starting ? new GraphicsGaveUpError('The notes engine stopped while starting on the graphics card') : new Error('The notes engine stopped unexpectedly')) }
      this.pending.clear()
      if (!this.disposed) for (const cb of this.exitListeners) cb()
    })
    return (this.proc = proc)
  }

  private call<T>(req: Req, onToken?: (t: string) => void): { id: number; done: Promise<T> } {
    const id = this.nextId++
    const model = req.type === 'load', load = model || req.type === 'probe'
    const done = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onToken, ...(load ? { load, model } : {}) }))
    this.ensure().postMessage({ ...req, id })
    return { id, done }
  }

  /**
   * The graphics the engine can use (Windows and Linux, before picking a model). Each backend in turn until one finds a
   * card (#32); with none, what the first one found, and the engine goes back to it.
   */
  async probe(): Promise<GpuProbe> {
    const order = this.opts.backends ?? [this.backend]
    let first: { probe: GpuProbe } | { error: Error } | undefined
    let firstCpuOnly = false
    for (const [i, b] of order.entries()) {
      this.use(b)
      const r = await this.probeOnce().then((probe) => ({ probe }), (error: Error) => ({ error }))
      if ('probe' in r && r.probe.gpuType) {
        // a change from what was tried first (the one saved last time) is saved for next time
        if (i > 0) this.opts.onBackend?.(b)
        return r.probe
      }
      if (i === 0) { first = r; firstCpuOnly = this.cpuOnly }
      if (i < order.length - 1) console.warn(`notes engine: no graphics card found with ${b === 'auto' ? 'the default build' : b}${'error' in r ? ` (${r.error.message})` : ''}; checking with ${order[i + 1] === 'auto' ? 'the default build' : order[i + 1]}`)
    }
    // the first one again, as it left things (a crash there: without the card)
    this.use(order[0])
    this.cpuOnly = firstCpuOnly
    if (!first || 'error' in first) throw first?.error ?? new Error('No graphics check ran')
    return first.probe
  }

  private probeOnce() {
    const { id, done } = this.call<GpuProbe>({ type: 'probe' })
    this.watch(id, 'checking the graphics', this.limits.probeMs, this.limits.probeMs)
    return done
  }
  load(modelPath: string, contextSize: number, minContext: number) {
    const model = this.model = fileName(modelPath)
    this.onCard = undefined
    const cap = this.capFor(model)
    console.info('NOTES', `loading the notes model ${model}${this.opts.gpuFallback ? (this.cpuOnly || cap === 0 ? ' without the graphics card' : ` (graphics card allowed${cap ? `, at most ${cap} layers: it ran out of memory with more` : ''})`) : ''}`)
    const { id, done } = this.call<{ contextSize: number; gpu?: string | false; gpuLayers?: number }>({ type: 'load', modelPath, contextSize, minContext, ...(cap !== undefined ? { gpuLayers: cap } : {}) })
    this.watch(id, 'loading the model', this.limits.loadMs, this.limits.cpuLoadMs)
    return done.then((r) => {
      if (this.model === model && r.gpu !== undefined) this.onCard = { model, layers: r.gpu ? r.gpuLayers ?? 0 : 0 }
      console.info('NOTES', `notes model loaded: context ${r.contextSize}, graphics ${r.gpu === undefined ? 'unknown' : r.gpu || 'none'}${r.gpu && r.gpuLayers !== undefined ? ` (${r.gpuLayers} layers)` : ''}`)
      return r
    })
  }
  async unload() { if (this.proc) await this.call({ type: 'unload' }).done }
  count(texts: string[]) { return this.call<number[]>({ type: 'count', texts }).done }
  chat(req: ChatRequest, onToken: (text: string) => void, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(new Error('Stopped'))
    const { id, done } = this.call<string>({ type: 'chat', messages: req.messages, thoughtBudget: req.thoughtBudget ?? 0, ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}), ...(req.temperature !== undefined ? { temperature: req.temperature } : {}) }, onToken)
    // the first word: reading the prompt in comes before it
    this.watch(id, 'the first word', this.limits.firstTokenMs, this.limits.cpuFirstTokenMs)
    signal?.addEventListener('abort', () => { this.call({ type: 'abort', targetId: id }).done.catch(() => {}) }, { once: true })
    return done
  }
  preload(messages: EngineMessage[], signal?: AbortSignal) {
    if (signal?.aborted) return Promise.resolve(0)
    const { id, done } = this.call<number>({ type: 'preload', messages })
    signal?.addEventListener('abort', () => { this.call({ type: 'abort', targetId: id }).done.catch(() => {}) }, { once: true })
    return done
  }
  embed(modelPath: string, texts: string[]) { return this.call<number[][]>({ type: 'embed', modelPath, texts }).done }
  async unloadEmbed() { if (this.proc) await this.call({ type: 'unload-embed' }).done }
  onExit(cb: () => void) { this.exitListeners.push(cb) }
  dispose() { this.disposed = true; this.proc?.kill() }
}
