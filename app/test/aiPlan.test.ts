import { describe, expect, it } from 'vitest'
import { pick, type Catalog, type Hardware } from '@yogurt/picker'
import bundled from '../../catalog/catalog.json'
import { aiPlan, toAiPlan } from '../src/main/aiPlan'

const models = (bundled as unknown as Catalog).models

const hw = (o: Partial<Hardware> & Pick<Hardware, 'gpu' | 'totalRamGB'>): Hardware => ({
  os: 'darwin', arch: 'arm64', cpuModel: 'Apple M1', freeDiskGB: 500, ...o,
})

const m1max = hw({ cpuModel: 'Apple M1 Max', totalRamGB: 34.4, gpu: { kind: 'unified', name: 'Apple M1 Max', vramGB: 0 } })
const mac8 = hw({ cpuModel: 'Apple M1', totalRamGB: 8.6, gpu: { kind: 'unified', name: 'Apple M1', vramGB: 0 } })
const cpu32 = hw({ os: 'linux', arch: 'x64', cpuModel: 'Intel Core i7-12700', totalRamGB: 34.4, gpu: { kind: 'none', name: '', vramGB: 0 } })
const win8 = hw({ os: 'win32', arch: 'x64', cpuModel: 'Intel Core i5', totalRamGB: 8.6, gpu: { kind: 'none', name: '', vramGB: 0 } })
const m4max = hw({ cpuModel: 'Apple M4 Max', totalRamGB: 137.4, freeDiskGB: 1000, gpu: { kind: 'unified', name: 'Apple M4 Max', vramGB: 0 } })

const ids = (choices: { modelId: string }[]) => choices.map((c) => c.modelId)

describe('the local AI plan', () => {
  it('answers with the hardware line, the recommended model and the ranked list', () => {
    const plan = aiPlan(m1max, models)
    expect(plan.hardware).toBe('Apple M1 Max, 32 GB, Metal')
    expect(plan.recommended).toMatchObject({ modelId: 'gemma-4-26b-a4b', contextSize: 16384, device: 'gpu' })
    expect(ids(plan.all)).toEqual(['gemma-4-26b-a4b', 'gemma-4-e4b', 'gpt-oss-20b', 'gemma-4-e2b'])
    expect(plan.liteMode).toBe(false)
    expect(plan.needsDiskGB).toBe(0)
  })

  it('carries the catalog description of every choice', () => {
    const plan = aiPlan(m1max, models)
    for (const c of plan.all) expect(c.description).toBe(models.find((m) => m.id === c.modelId)!.description)
    expect(plan.recommended?.description).toBe('High quality and still fast on a capable computer')
  })

  it('an incompatible model says why and how much memory it would need', () => {
    const plan = aiPlan(m1max, models)
    expect(plan.unavailable).toContainEqual(expect.objectContaining({
      modelId: 'gpt-oss-120b', name: 'gpt-oss 120B', reason: 'memory', needsMemoryGB: 66.2,
      description: 'The best quality, for powerful computers',
    }))
    const slow = aiPlan(cpu32, models).unavailable.find((u) => u.reason === 'slow')
    expect(slow).toMatchObject({ modelId: 'gemma-4-e4b', needsMemoryGB: 7.9 })
  })

  it('an 8 GB Mac sees the compact choice and the full memory of what does not fit', () => {
    const plan = aiPlan(mac8, models)
    expect(plan.recommended).toMatchObject({ modelId: 'gemma-4-e4b-compact', contextSize: 8192 })
    expect(plan.unavailable.find((u) => u.modelId === 'gemma-4-26b-a4b')?.needsMemoryGB).toBe(17.2)
  })

  it('says how much disk to free for the recommended download', () => {
    const plan = aiPlan({ ...m1max, freeDiskGB: 20 }, models)
    expect(plan.needsDiskGB).toBeCloseTo(4.44, 2)
    expect(plan.recommended?.needsDiskGB).toBeCloseTo(4.44, 2)
  })

  it('a lite computer gets the last-resort model and lite mode', () => {
    const plan = aiPlan(win8, models)
    expect(plan.recommended?.modelId).toBe('qwen3-1.7b')
    expect(plan.liteMode).toBe(true)
  })

  it('maps the faster and smarter alternatives when the picker offers them', () => {
    const faster = aiPlan(m4max, models)
    expect(faster.recommended?.modelId).toBe('gpt-oss-120b')
    expect(faster.faster?.modelId).toBe('gemma-4-e2b')

    const picked = pick(m1max, models)
    const both = toAiPlan(m1max, { ...picked, faster: picked.recommended!, smarter: picked.recommended! })
    expect(both.faster?.modelId).toBe('gemma-4-26b-a4b')
    expect(both.smarter?.modelId).toBe('gemma-4-26b-a4b')
  })
})
