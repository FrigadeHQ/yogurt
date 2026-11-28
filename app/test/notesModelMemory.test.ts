import { describe, expect, it, vi } from 'vitest'
import { createNotesModel } from '../src/main/notes/model'
import { notesMemory, IDLE_UNLOAD_MS } from '../src/main/notes/queue'
import { CONTEXT } from '../src/shared/engine-protocol'
import type { Engine } from '../src/main/engine'

function rig(o: { contextSize?: number; beforeLoad?: () => Promise<void>; onLoaded?: (path: string) => void }) {
  const calls: string[] = []
  const engine: Engine = {
    load: vi.fn(async (_p: string, ctx: number) => { calls.push(`load ${ctx}`); return { contextSize: ctx } }),
    unload: async () => {}, count: async (t) => t.map(() => 1), preload: async () => 0, embed: async () => [], unloadEmbed: async () => {}, dispose: () => {},
    onExit: () => {}, chat: vi.fn(async () => 'x'),
  }
  const model = createNotesModel({ engine, modelPath: () => '/m.gguf', ...o, beforeLoad: o.beforeLoad && (async () => { calls.push('before'); await o.beforeLoad!() }) })
  return { calls, model }
}

describe('the notes model on a Mac with little memory (a 24 GB Mac froze with whisper and the 26B model loaded together)', () => {
  it('uses one requested model, then returns to Auto without retiring either model manually', async () => {
    const onLoaded = vi.fn()
    const r = rig({ contextSize: 16_384, onLoaded })
    const override = { path: '/26b.gguf', contextSize: 8192 }
    await expect(r.model.llm(undefined, override)).resolves.toMatchObject({ contextSize: 8192 })
    expect(r.model.loaded()).toBe('/26b.gguf')
    expect(onLoaded).not.toHaveBeenCalled()
    await expect(r.model.llm()).resolves.toMatchObject({ contextSize: 16_384 })
    expect(r.model.loaded()).toBe('/m.gguf')
    expect(onLoaded).toHaveBeenCalledExactlyOnceWith('/m.gguf')
  })

  it('loads with the context it is given, after letting go of what it is told to first, once', async () => {
    const r = rig({ contextSize: 16_384, beforeLoad: async () => {} })
    await expect(r.model.llm()).resolves.toMatchObject({ contextSize: 16_384 })
    await r.model.llm()
    expect(r.calls).toEqual(['before', 'load 16384'])
  })
  it('a bigger Mac keeps the full context and lets nothing go', async () => {
    const r = rig({})
    await r.model.llm()
    expect(r.calls).toEqual([`load ${CONTEXT}`])
  })
  it('the plan: a small Mac uses half the context, lets whisper go first and the notes model go after a minute idle', () => {
    expect(notesMemory(true)).toEqual({ contextSize: 16_384, idleMs: 60_000, releaseSpeech: true })
    expect(notesMemory(false)).toEqual({ contextSize: CONTEXT, idleMs: IDLE_UNLOAD_MS, releaseSpeech: false })
  })
})
