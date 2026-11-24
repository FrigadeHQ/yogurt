import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** a stand-in utility process: records what it was sent and how it was started; answers only when told */
class Proc extends EventEmitter {
  sent: any[] = []
  killed = false
  constructor(public env?: Record<string, string | undefined>) { super() }
  postMessage(m: any) { this.sent.push(m) }
  kill() { if (this.killed) return true; this.killed = true; queueMicrotask(() => this.emit('exit', 1)); return true }
  answer(type: string, data: unknown = null) { const m = this.sent.find((x) => x.type === type); this.emit('message', { id: m.id, type: 'result', data }) }
  fail(type: string, message: string) { const m = this.sent.find((x) => x.type === type); this.emit('message', { id: m.id, type: 'error', message }) }
}
const procs: Proc[] = []
vi.mock('electron', () => ({ utilityProcess: { fork: (_p: string, _a: string[], o: { env?: Record<string, string> }) => { const p = new Proc(o.env); procs.push(p); return p } } }))
const { UtilityEngine, backendOrder } = await import('../src/main/engine')

const card = { gpuType: 'vulkan', vramTotalGB: 12.9, unifiedGB: 0, gpuNames: ['NVIDIA GeForce RTX 3080 Ti'] }
const none = { gpuType: false, vramTotalGB: 0, unifiedGB: 0, gpuNames: [] }
const backend = (p: Proc) => p.env?.YOGURT_ENGINE_GPU
/** lets the engine move on to the next process, then returns it */
const next = async (n: number) => { await vi.waitFor(() => expect(procs.length).toBe(n)); await vi.waitFor(() => expect(procs[n - 1].sent.length).toBeGreaterThan(0)); return procs[n - 1] }

beforeEach(() => { procs.length = 0; vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'info').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks() })

describe('which graphics backends the notes engine checks (#32)', () => {
  it('Windows and Linux: node-llama-cpp first, then Vulkan; a Mac only ever its own', () => {
    expect(backendOrder('linux', {})).toEqual(['auto', 'vulkan'])
    expect(backendOrder('win32', {})).toEqual(['auto', 'vulkan'])
    expect(backendOrder('darwin', {})).toEqual(['auto'])
  })
  it('the one that worked last time goes first', () => {
    expect(backendOrder('linux', {}, 'vulkan')).toEqual(['vulkan', 'auto'])
  })
  it('a NODE_LLAMA_CPP_GPU the person set is left alone', () => {
    expect(backendOrder('linux', { NODE_LLAMA_CPP_GPU: 'cuda' }, 'vulkan')).toEqual(['auto'])
  })
})

describe('the notes engine finds the graphics card with Vulkan when CUDA does not start (#32)', () => {
  it('no card with the CUDA build: the engine starts again on Vulkan, finds it, keeps it and says so', async () => {
    const saved: string[] = []
    const e = new UtilityEngine('engine.js', { gpuFallback: true, backends: ['auto', 'vulkan'], onBackend: (b) => saved.push(b) })
    const probe = e.probe()
    const first = await next(1)
    expect(backend(first)).toBeUndefined()
    first.answer('probe', none)
    const second = await next(2)
    expect(first.killed).toBe(true)
    expect(backend(second)).toBe('vulkan')
    second.answer('probe', card)
    await expect(probe).resolves.toEqual(card)
    expect(saved).toEqual(['vulkan'])
    // the model loads in the same Vulkan engine
    const load = e.load('m.gguf', 32768, 8192)
    expect(procs).toHaveLength(2)
    second.answer('load', { contextSize: 32768 })
    await expect(load).resolves.toMatchObject({ contextSize: 32768 })
  })

  it('a CUDA build that fails to load (an error, not a crash) tries Vulkan too', async () => {
    const e = new UtilityEngine('engine.js', { gpuFallback: true, backends: ['auto', 'vulkan'] })
    const probe = e.probe()
    ;(await next(1)).fail('probe', 'ggml_cuda_init: failed to initialize CUDA: unknown error')
    ;(await next(2)).answer('probe', card)
    await expect(probe).resolves.toEqual(card)
  })

  it('a crash while checking with CUDA tries Vulkan on the card, not the processor', async () => {
    const e = new UtilityEngine('engine.js', { gpuFallback: true, backends: ['auto', 'vulkan'] })
    const probe = e.probe()
    const first = await next(1)
    first.emit('exit', 132)
    const second = await next(2)
    expect(backend(second)).toBe('vulkan')
    second.answer('probe', card)
    await expect(probe).resolves.toEqual(card)
  })

  it('a card found the first time: one engine, nothing saved', async () => {
    const saved: string[] = []
    const e = new UtilityEngine('engine.js', { gpuFallback: true, backends: ['auto', 'vulkan'], onBackend: (b) => saved.push(b) })
    const probe = e.probe()
    ;(await next(1)).answer('probe', { ...card, gpuType: 'cuda' })
    await expect(probe).resolves.toMatchObject({ gpuType: 'cuda' })
    expect(procs).toHaveLength(1)
    expect(saved).toEqual([])
  })

  it('Vulkan saved from last time, but now only CUDA finds the card: CUDA is kept and saved', async () => {
    const saved: string[] = []
    const e = new UtilityEngine('engine.js', { gpuFallback: true, backends: ['vulkan', 'auto'], onBackend: (b) => saved.push(b) })
    const probe = e.probe()
    const first = await next(1)
    expect(backend(first)).toBe('vulkan')
    first.answer('probe', none)
    const second = await next(2)
    expect(backend(second)).toBeUndefined()
    second.answer('probe', { ...card, gpuType: 'cuda' })
    await expect(probe).resolves.toMatchObject({ gpuType: 'cuda' })
    expect(saved).toEqual(['auto'])
  })

  it('no card with either: what the first check found, and the engine goes back to node-llama-cpp\'s own pick', async () => {
    const saved: string[] = []
    const e = new UtilityEngine('engine.js', { gpuFallback: true, backends: ['auto', 'vulkan'], onBackend: (b) => saved.push(b) })
    const probe = e.probe()
    ;(await next(1)).answer('probe', none)
    ;(await next(2)).fail('probe', 'No prebuilt binaries found')
    await expect(probe).resolves.toEqual(none)
    expect(saved).toEqual([])
    void e.load('m.gguf', 32768, 8192).catch(() => {})
    const third = await next(3)
    expect(backend(third)).toBeUndefined()
  })

  it('without the graphics card, Vulkan or not, the engine runs on the processor', async () => {
    const e = new UtilityEngine('engine.js', { gpuFallback: true, backends: ['vulkan', 'auto'] })
    void e.load('m.gguf', 32768, 8192).catch(() => {})
    const first = await next(1)
    expect(backend(first)).toBe('vulkan')
    first.emit('exit', 1)
    void e.load('m.gguf', 32768, 8192).catch(() => {})
    expect(backend(await next(2))).toBe('off')
  })
})
