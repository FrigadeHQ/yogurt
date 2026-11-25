import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Gemma4ChatWrapper, type LlamaChatSessionOptions } from 'node-llama-cpp'
import { createLlm } from '../src/engine/llm'

const fake = vi.hoisted(() => ({ architecture: 'gemma4', sessions: [] as unknown[], loads: [] as unknown[], llamas: [] as unknown[], disposed: 0, contextFails: 0, loadFails: 0, contextError: undefined as (() => Error) | undefined, warmFails: 0, vram: { total: 0, unifiedSize: 0 }, caps: [] as unknown[] }))
vi.mock('node-llama-cpp', async (original) => {
  const actual = await original<typeof import('node-llama-cpp')>()
  const sequence = { contextTokens: [], tokenMeter: { usedInputTokens: 0 }, evaluateWithoutGeneratingNewTokens: async () => { if (fake.warmFails > 0) { fake.warmFails--; throw new Error('vk::Device::allocateMemory: ErrorOutOfDeviceMemory') } } }
  return {
    ...actual,
    getLlama: async (opts?: { gpu?: false }) => (fake.llamas.push(opts), { gpu: opts?.gpu === false ? false : 'vulkan', getVramState: async () => ({ ...fake.vram, free: fake.vram.total, used: 0 }), setVramCap: async (b: number) => { fake.caps.push(b) }, getGpuDeviceNames: async () => [], loadModel: async (o: { gpuLayers?: unknown }) => {
      fake.loads.push(o.gpuLayers)
      if (fake.loadFails > 0 && o.gpuLayers !== 0) { fake.loadFails--; throw new Error('Failed to load model') }
      return {
        fileInfo: { metadata: { general: { architecture: fake.architecture } } }, gpuLayers: o.gpuLayers === 0 || opts?.gpu === false ? 0 : 20,
        tokenize: () => [], dispose: async () => { fake.disposed++ },
        createContext: async () => {
          if (fake.contextFails > 0) { fake.contextFails--; throw fake.contextError?.() ?? new actual.InsufficientMemoryError('A context size of 8192 is too large for the available VRAM') }
          return { contextSize: 8192, getSequence: () => sequence, dispose: async () => {} }
        },
      }
    } }),
    LlamaChatSession: class {
      constructor(options: LlamaChatSessionOptions) { fake.sessions.push(options) }
      setChatHistory() {}
      async preloadPrompt() {}
      async prompt() { return '' }
      dispose() {}
    },
  }
})

beforeEach(() => { fake.sessions.length = 0; fake.loads.length = 0; fake.llamas.length = 0; fake.disposed = 0; fake.contextFails = 0; fake.loadFails = 0; fake.contextError = undefined; fake.warmFails = 0; fake.vram = { total: 0, unifiedSize: 0 }; fake.caps.length = 0 })

describe('model prompt wrapper', () => {
  it.each(['gemma4', 'qwen3', 'gpt-oss'])('preload and answers use the same format for %s', async (architecture) => {
    fake.architecture = architecture
    const llm = createLlm()
    await llm.load('fixture.gguf', 8192, 8192)
    const messages = [{ role: 'user' as const, content: 'Synthetic transcript.' }]
    await llm.preload(messages)
    await llm.chat({ messages, thoughtBudget: 0 }, () => {})
    expect(fake.sessions).toHaveLength(2)
    for (const { chatWrapper } of fake.sessions as LlamaChatSessionOptions[]) {
      if (architecture === 'gemma4') {
        expect(chatWrapper).toBeInstanceOf(Gemma4ChatWrapper)
        const wrapper = chatWrapper as Gemma4ChatWrapper
        expect(wrapper.reasoning).toBe(false)
        const context = wrapper.generateContextState({ chatHistory: [{ type: 'user', text: 'Synthetic transcript.' }, { type: 'model', response: [] }] }).contextText.toString()
        expect(context).toContain('<|turn>user\nSynthetic transcript.')
        expect(context).not.toContain('<|think|>')
      } else expect(chatWrapper ?? 'auto').toBe('auto')
    }
    await llm.unload()
  })
})

describe('too little room on the graphics card for the notes', () => {
  it('loads once, as before, when the context fits', async () => {
    const llm = createLlm()
    expect(await llm.load('fixture.gguf', 32768, 8192)).toMatchObject({ gpu: 'vulkan', gpuLayers: 20 })
    expect(fake.loads).toEqual([undefined])
  })
  it('loads again with room left for the notes on the card, when the context did not fit', async () => {
    fake.contextFails = 1
    const llm = createLlm()
    await llm.load('fixture.gguf', 32768, 8192)
    expect(fake.loads).toEqual([undefined, { fitContext: { contextSize: 8192 } }])
    expect(fake.disposed).toBe(1)
  })
  it('runs on the processor alone when even that does not fit', async () => {
    fake.contextFails = 2
    const llm = createLlm()
    expect(await llm.load('fixture.gguf', 32768, 8192)).toMatchObject({ gpu: false, gpuLayers: 0 })
    expect(fake.loads).toEqual([undefined, { fitContext: { contextSize: 8192 } }, 0])
  })
  it('with graphics that say they have no room even with no layers on them (an Intel Arc, #57), runs with the graphics off', async () => {
    fake.contextFails = 3
    const r = await createLlm().load('fixture.gguf', 32768, 8192)
    expect(r).toMatchObject({ gpu: false, gpuLayers: 0 })
    expect(fake.llamas.at(-1)).toEqual({ gpu: false })
  })
  it('gives up when the processor alone does not fit either', async () => {
    fake.contextFails = 4
    await expect(createLlm().load('fixture.gguf', 32768, 8192)).rejects.toThrow(/too large/)
  })
  it('a model too big for the card that fails to load at all loads again with fewer layers there (#37)', async () => {
    fake.loadFails = 1
    const llm = createLlm()
    expect(await llm.load('fixture.gguf', 32768, 8192)).toMatchObject({ gpu: 'vulkan', gpuLayers: 20 })
    expect(fake.loads).toEqual([undefined, { fitContext: { contextSize: 8192 } }])
  })
  it('falls back to the processor when the model fails to load on the card twice', async () => {
    fake.loadFails = 2
    expect(await createLlm().load('fixture.gguf', 32768, 8192)).toMatchObject({ gpu: false, gpuLayers: 0 })
    expect(fake.loads).toEqual([undefined, { fitContext: { contextSize: 8192 } }, 0])
  })
  it('another error is not retried', async () => {
    fake.contextFails = 1; fake.contextError = () => new Error('bad file')
    await expect(createLlm().load('fixture.gguf', 32768, 8192)).rejects.toThrow('bad file')
    expect(fake.loads).toEqual([undefined])
  })
})

describe('the card\'s real memory, and fewer layers after it ran out (#165)', () => {
  it('a card next to built-in graphics: the model plans for the card\'s own memory only', async () => {
    fake.vram = { total: 21.2 * 1024 ** 3, unifiedSize: 17.2 * 1024 ** 3 }
    await createLlm({ platform: 'win32' }).load('fixture.gguf', 32768, 8192)
    expect(fake.caps).toHaveLength(1)
    expect(fake.caps[0]).toBeLessThan(4 * 1024 ** 3)
    // the check of the graphics still reports them as found: the picker needs the whole picture
    const llm = createLlm({ platform: 'win32' })
    fake.llamas.length = 0
    expect(await llm.probe()).toMatchObject({ vramTotalGB: 21.2 * 1024 ** 3 / 1e9, unifiedGB: 17.2 * 1024 ** 3 / 1e9 })
    // a Mac: as before
    fake.caps.length = 0
    await createLlm({ platform: 'darwin' }).load('fixture.gguf', 32768, 8192)
    expect(fake.caps).toHaveLength(0)
  })
  it('with a cap from the engine: never more layers than that, then fewer, then the processor', async () => {
    fake.contextFails = 2
    expect(await createLlm().load('fixture.gguf', 32768, 8192, 21)).toMatchObject({ gpu: false, gpuLayers: 0 })
    expect(fake.loads).toEqual([{ max: 21 }, { max: 21, fitContext: { contextSize: 8192 } }, 0])
  })
  it('a cap of none: the processor alone, the graphics never touched', async () => {
    expect(await createLlm().load('fixture.gguf', 32768, 8192, 0)).toMatchObject({ gpu: false, gpuLayers: 0 })
    expect(fake.llamas).toEqual([{ gpu: false }])
  })
  it('running out at the first words read in: loaded again with fewer layers', async () => {
    fake.warmFails = 1
    expect(await createLlm().load('fixture.gguf', 32768, 8192)).toMatchObject({ gpu: 'vulkan', gpuLayers: 20 })
    expect(fake.loads).toEqual([undefined, { fitContext: { contextSize: 8192 } }])
  })
})
