import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** a stand-in utility process: records what it was sent and how it was started; answers only when told */
class Proc extends EventEmitter {
  sent: any[] = []
  killed = false
  constructor(public env?: Record<string, string | undefined>) { super() }
  postMessage(m: any) { this.sent.push(m) }
  kill() { if (this.killed) return true; this.killed = true; queueMicrotask(() => this.emit('exit', 1)); return true }
  last(type: string) { return this.sent.filter((x) => x.type === type).at(-1) }
  answer(type: string, data: unknown = null) { this.emit('message', { id: this.last(type).id, type: 'result', data }) }
  fail(type: string, message: string) { this.emit('message', { id: this.last(type).id, type: 'error', message }) }
}
const procs: Proc[] = []
vi.mock('electron', () => ({ utilityProcess: { fork: (_p: string, _a: string[], o: { env?: Record<string, string> }) => { const p = new Proc(o.env); procs.push(p); return p } } }))
const { UtilityEngine, GraphicsGaveUpError, GraphicsFullError, fewerLayers, outOfGraphicsMemory } = await import('../src/main/engine')

const chat = { messages: [{ role: 'user' as const, content: 'hi' }] }
const OOM = 'vk::Device::allocateMemory: ErrorOutOfDeviceMemory'

beforeEach(() => { procs.length = 0; vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'info').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks() })

describe('the graphics card running out of memory (#165)', () => {
  it('knows Vulkan and CUDA running out of memory, and nothing else', () => {
    expect(outOfGraphicsMemory(OOM)).toBe(true)
    expect(outOfGraphicsMemory('VK_ERROR_OUT_OF_DEVICE_MEMORY')).toBe(true)
    expect(outOfGraphicsMemory('CUDA error: out of memory')).toBe(true)
    expect(outOfGraphicsMemory('ggml_backend_cuda_buffer_type_alloc_buffer: allocating 512.00 MiB on device 0: cudaMalloc failed: out of memory')).toBe(true)
    expect(outOfGraphicsMemory('vk::Queue::submit: ErrorDeviceLost')).toBe(false)
    expect(outOfGraphicsMemory('Last message must be from the user')).toBe(false)
  })

  it('each time: half the layers, then the processor alone', () => {
    expect(fewerLayers(43)).toBe(21)
    expect(fewerLayers(21)).toBe(10)
    expect(fewerLayers(10)).toBe(5)
    expect(fewerLayers(5)).toBe(0)
    expect(fewerLayers(0)).toBe(0)
  })
})

describe('the notes engine when the card runs out of memory (#165)', () => {
  const load = async (e: InstanceType<typeof UtilityEngine>, layers: number, file = 'C:\\m\\gemma-4-e4b.gguf') => {
    const l = e.load(file, 32768, 8192)
    const p = procs.at(-1)!
    p.answer('load', { contextSize: 32768, gpu: layers ? 'vulkan' : false, gpuLayers: layers })
    await l
    return p
  }

  it('at the first question: a fresh engine with half the layers, kept for next launch, and a give-up the notes try again', async () => {
    const saved: unknown[] = []
    const e = new UtilityEngine('engine.js', { gpuFallback: true, onGpuLayers: (l) => saved.push(l) })
    const first = await load(e, 43)
    expect(first.last('load').gpuLayers).toBeUndefined()
    const c = e.chat(chat, () => {}).catch((x) => x)
    first.fail('chat', OOM)
    const err = await c
    expect(err).toBeInstanceOf(GraphicsFullError)
    expect(err).toBeInstanceOf(GraphicsGaveUpError)
    expect(first.killed).toBe(true)
    expect(saved).toEqual([{ model: 'gemma-4-e4b.gguf', layers: 21 }])
    // the card stays on: only fewer layers
    const second = await load(e, 21)
    expect(second.env?.YOGURT_ENGINE_GPU).toBeUndefined()
    expect(second.last('load').gpuLayers).toBe(21)
  })

  it('reading a meeting in ahead counts too; down to the processor, where it stops stepping', async () => {
    const saved: unknown[] = []
    const e = new UtilityEngine('engine.js', { gpuFallback: true, onGpuLayers: (l) => saved.push(l) })
    for (const layers of [43, 21, 10, 5]) {
      const p = await load(e, layers)
      const r = e.preload(chat.messages).catch((x) => x)
      p.fail('preload', OOM)
      expect(await r).toBeInstanceOf(GraphicsFullError)
    }
    expect(saved.map((s: any) => s.layers)).toEqual([21, 10, 5, 0])
    const cpu = await load(e, 0)
    expect(cpu.last('load').gpuLayers).toBe(0)
    // on the processor the card can't run out: a plain error, the engine keeps running
    const r = e.chat(chat, () => {}).catch((x) => x)
    cpu.fail('chat', OOM)
    expect(await r).not.toBeInstanceOf(GraphicsGaveUpError)
    expect(cpu.killed).toBe(false)
  })

  it('a load that still runs out (its own fewer layers did not help): straight to the processor', async () => {
    const saved: unknown[] = []
    const e = new UtilityEngine('engine.js', { gpuFallback: true, onGpuLayers: (l) => saved.push(l) })
    const l = e.load('/m/gemma-4-e4b.gguf', 32768, 8192).catch((x) => x)
    procs[0].fail('load', OOM)
    expect(await l).toBeInstanceOf(GraphicsFullError)
    expect(saved).toEqual([{ model: 'gemma-4-e4b.gguf', layers: 0 }])
  })

  it('what was kept from last time is used from the first load, for that model only', async () => {
    const e = new UtilityEngine('engine.js', { gpuFallback: true, gpuLayers: { model: 'gemma-4-e4b.gguf', layers: 10 } })
    const p = await load(e, 10)
    expect(p.last('load').gpuLayers).toBe(10)
    void e.load('/m/gemma-4-26b.gguf', 32768, 8192).catch(() => {})
    expect(p.last('load').gpuLayers).toBeUndefined()
  })

  it('a Mac never steps down', async () => {
    const e = new UtilityEngine('engine.js')
    const p = await load(e, 43)
    const c = e.chat(chat, () => {}).catch((x) => x)
    p.fail('chat', OOM)
    expect(await c).not.toBeInstanceOf(GraphicsGaveUpError)
  })
})
