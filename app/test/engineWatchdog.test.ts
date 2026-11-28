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
  token(type: string, text: string) { const m = this.sent.find((x) => x.type === type); this.emit('message', { id: m.id, type: 'token', text }) }
}
const procs: Proc[] = []
vi.mock('electron', () => ({ utilityProcess: { fork: (_p: string, _a: string[], o: { env?: Record<string, string> }) => { const p = new Proc(o.env); procs.push(p); return p } } }))
const { UtilityEngine, GraphicsGaveUpError, engineShim } = await import('../src/main/engine')

const limits = { probeMs: 1000, loadMs: 1000, firstTokenMs: 1000, cpuLoadMs: 5000, cpuFirstTokenMs: 5000 }
const chat = { messages: [{ role: 'user' as const, content: 'hi' }] }

beforeEach(() => { procs.length = 0; vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'info').mockImplementation(() => {}) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('the notes engine off a Mac: a graphics card that hangs', () => {
  it('a model load that takes too long on the graphics card starts the engine again without it', async () => {
    const e = new UtilityEngine('engine.js', { gpuFallback: true, ...limits })
    const load = e.load('m.gguf', 32768, 8192)
    const caught = load.catch((x) => x)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await caught).toBeInstanceOf(GraphicsGaveUpError)
    expect(procs[0].killed).toBe(true)
    // the next load runs without the graphics card
    const again = e.load('m.gguf', 32768, 8192)
    expect(procs).toHaveLength(2)
    expect(procs[1].env?.YOGURT_ENGINE_GPU).toBe('off')
    procs[1].answer('load', { contextSize: 32768 })
    await expect(again).resolves.toEqual({ contextSize: 32768 })
  })

  it('without the graphics card it waits longer, then gives up plainly (never an endless wait)', async () => {
    const e = new UtilityEngine('engine.js', { gpuFallback: true, ...limits })
    void e.load('m.gguf', 32768, 8192).catch(() => {})
    await vi.advanceTimersByTimeAsync(1001)
    const slow = e.load('m.gguf', 32768, 8192).catch((x) => x)
    await vi.advanceTimersByTimeAsync(4000)
    expect(procs[1].killed).toBe(false)
    await vi.advanceTimersByTimeAsync(1001)
    const err = await slow
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(GraphicsGaveUpError)
    expect(procs[1].killed).toBe(true)
  })

  it('no first word on the graphics card in time: the same fallback; a word in time keeps it', async () => {
    const e = new UtilityEngine('engine.js', { gpuFallback: true, ...limits })
    const l = e.load('m.gguf', 32768, 8192); procs[0].answer('load', { contextSize: 32768 }); await l
    const words: string[] = []
    const ok = e.chat(chat, (t) => words.push(t))
    await vi.advanceTimersByTimeAsync(900)
    procs[0].token('chat', 'Hello')
    await vi.advanceTimersByTimeAsync(5000)
    procs[0].answer('chat', 'Hello')
    await expect(ok).resolves.toBe('Hello')
    expect(procs[0].killed).toBe(false)

    const stuck = e.chat(chat, () => {}).catch((x) => x)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await stuck).toBeInstanceOf(GraphicsGaveUpError)
    expect(procs[0].killed).toBe(true)
  })

  it('a graphics check that hangs gives up on the card instead of holding setup', async () => {
    const e = new UtilityEngine('engine.js', { gpuFallback: true, ...limits })
    const probe = e.probe().catch((x) => x)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await probe).toBeInstanceOf(GraphicsGaveUpError)
    void e.load('m.gguf', 32768, 8192).catch(() => {})
    expect(procs[1].env?.YOGURT_ENGINE_GPU).toBe('off')
  })

  it('tells the log which graphics the model loaded on', async () => {
    const e = new UtilityEngine('engine.js', { gpuFallback: true, ...limits })
    const l = e.load('C:\\models\\llm\\gemma.gguf', 32768, 8192)
    expect(console.info).toHaveBeenCalledWith('NOTES', expect.stringContaining('loading the notes model gemma.gguf'))
    procs[0].answer('load', { contextSize: 16384, gpu: 'vulkan' })
    await l
    expect(console.info).toHaveBeenCalledWith('NOTES', expect.stringContaining('vulkan'))
  })
})

describe('the notes engine on a Mac', () => {
  it('has no time limits: a slow load still finishes, nothing is restarted', async () => {
    const e = new UtilityEngine('engine.js')
    const load = e.load('m.gguf', 32768, 8192)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    procs[0].answer('load', { contextSize: 32768 })
    await expect(load).resolves.toEqual({ contextSize: 32768 })
    expect(procs).toHaveLength(1)
    expect(procs[0].killed).toBe(false)
  })
})

describe('the notes engine off a Mac: a graphics card that is lost, and a processor that crashes (#32, #36)', () => {
  const fail = (p: Proc, type: string, message: string) => { const m = p.sent.find((x) => x.type === type); p.emit('message', { id: m.id, type: 'error', message }) }
  const loaded = async (e: InstanceType<typeof UtilityEngine>, p = 0) => { const l = e.load('m.gguf', 32768, 8192); procs[p].answer('load', { contextSize: 32768 }); await l }

  it('a lost graphics device stops the engine (that process can never use the card again) and the next try starts fresh', async () => {
    const e = new UtilityEngine('engine.js', { gpuFallback: true, ...limits })
    await loaded(e)
    const exits: number[] = []
    e.onExit(() => exits.push(1))
    const c = e.chat(chat, () => {}).catch((x) => x)
    fail(procs[0], 'chat', 'vk::Queue::submit: ErrorDeviceLost')
    expect(await c).toBeInstanceOf(GraphicsGaveUpError)
    expect(procs[0].killed).toBe(true)
    expect(exits).toEqual([1])
    void e.load('m.gguf', 32768, 8192).catch(() => {})
    expect(procs).toHaveLength(2)
  })

  it('on Windows the next try runs on the processor; on Linux, where the processor crashes, on the card again', async () => {
    const win = new UtilityEngine('engine.js', { gpuFallback: true, ...limits })
    await loaded(win)
    const c = win.chat(chat, () => {}).catch((x) => x)
    fail(procs[0], 'chat', 'vk::Queue::submit: ErrorDeviceLost'); await c
    void win.load('m.gguf', 32768, 8192).catch(() => {})
    expect(procs[1].env?.YOGURT_ENGINE_GPU).toBe('off')

    procs.length = 0
    const linux = new UtilityEngine('engine.js', { gpuFallback: true, cpuCrashes: true, ...limits })
    await loaded(linux)
    const d = linux.chat(chat, () => {}).catch((x) => x)
    fail(procs[0], 'chat', 'VK_ERROR_DEVICE_LOST'); await d
    void linux.load('m.gguf', 32768, 8192).catch(() => {})
    expect(procs[1].env?.YOGURT_ENGINE_GPU).toBeUndefined()
  })

  it('an ordinary error leaves the engine running', async () => {
    const e = new UtilityEngine('engine.js', { gpuFallback: true, ...limits })
    await loaded(e)
    const c = e.chat(chat, () => {}).catch((x) => x)
    fail(procs[0], 'chat', 'Last message must be from the user')
    expect(await c).not.toBeInstanceOf(GraphicsGaveUpError)
    expect(procs[0].killed).toBe(false)
  })

  it('the engine crashing as it loads without the card turns the card back on for the next try, not CPU for the whole session', async () => {
    const e = new UtilityEngine('engine.js', { gpuFallback: true, ...limits })
    const first = e.load('m.gguf', 32768, 8192).catch((x) => x)
    procs[0].emit('exit', 132)
    expect(await first).toBeInstanceOf(GraphicsGaveUpError)
    const second = e.load('m.gguf', 32768, 8192).catch((x) => x)
    expect(procs[1].env?.YOGURT_ENGINE_GPU).toBe('off')
    procs[1].emit('exit', 132)
    expect(await second).not.toBeInstanceOf(GraphicsGaveUpError)
    void e.load('m.gguf', 32768, 8192).catch(() => {})
    expect(procs[2].env?.YOGURT_ENGINE_GPU).toBeUndefined()
  })
})

describe('Linux: big allocations kept away from Electron\'s allocator (#32)', () => {
  it('the shim is used on Linux only, and only when it was shipped', () => {
    const has = () => true, none = () => false
    expect(engineShim('linux', ['/r/bin/libyogurt-bigalloc.so'], has)).toBe('/r/bin/libyogurt-bigalloc.so')
    expect(engineShim('linux', ['/r/bin/libyogurt-bigalloc.so'], none)).toBeUndefined()
    expect(engineShim('darwin', ['/r/bin/libyogurt-bigalloc.so'], has)).toBeUndefined()
    expect(engineShim('win32', ['/r/bin/libyogurt-bigalloc.so'], has)).toBeUndefined()
    // LD_PRELOAD splits on spaces and colons: such a path would never load, so the next one (or none) is used
    expect(engineShim('linux', ['/My Apps/bin/libyogurt-bigalloc.so', '/a:b/libyogurt-bigalloc.so', '/r/bin/libyogurt-bigalloc.so'], has)).toBe('/r/bin/libyogurt-bigalloc.so')
  })

  it('with the shim, every engine process gets it in LD_PRELOAD, on the card or not, next to one already set', async () => {
    const before = process.env.LD_PRELOAD
    process.env.LD_PRELOAD = '/home/me/other.so'
    try {
      const e = new UtilityEngine('engine.js', { gpuFallback: true, preload: '/r/bin/libyogurt-bigalloc.so', ...limits })
      void e.load('m.gguf', 32768, 8192).catch(() => {})
      expect(procs[0].env?.LD_PRELOAD).toBe('/r/bin/libyogurt-bigalloc.so:/home/me/other.so')
      expect(procs[0].env?.YOGURT_ENGINE_GPU).toBeUndefined()
      procs[0].emit('exit', 132)
      void e.load('m.gguf', 32768, 8192).catch(() => {})
      expect(procs[1].env?.LD_PRELOAD).toBe('/r/bin/libyogurt-bigalloc.so:/home/me/other.so')
      expect(procs[1].env?.YOGURT_ENGINE_GPU).toBe('off')
    } finally {
      if (before === undefined) delete process.env.LD_PRELOAD
      else process.env.LD_PRELOAD = before
    }
  })

  it('without it (a Mac, Windows) the engine starts with the app\'s own environment, as before', async () => {
    const e = new UtilityEngine('engine.js', { gpuFallback: true, ...limits })
    void e.load('m.gguf', 32768, 8192).catch(() => {})
    expect(procs[0].env).toBeUndefined()
  })
})

describe('the engine\'s own lines reach main.log (#190)', () => {
  it('a warning or info line from the worker is logged in main, tagged NOTES', () => {
    const e = new UtilityEngine('engine.js', { gpuFallback: true, ...limits })
    void e.count(['a']).catch(() => {})
    procs[0].emit('message', { type: 'log', level: 'warn', text: 'the embedding model did not fit on the graphics' })
    procs[0].emit('message', { type: 'log', level: 'info', text: 'notes engine: plans for 14.7 GiB of graphics memory' })
    expect(console.warn).toHaveBeenCalledWith('NOTES', 'the embedding model did not fit on the graphics')
    expect(console.info).toHaveBeenCalledWith('NOTES', 'notes engine: plans for 14.7 GiB of graphics memory')
  })
})
