import { describe, expect, it } from 'vitest'
import { hardwareLine, toHardware } from '../src/main/hardware'

const sys = { platform: 'darwin', arch: 'arm64', cpuModel: 'Apple M2', totalRamBytes: 8_589_934_592, freeDiskGB: 123.456 }

describe('toHardware', () => {
  it('an Apple Silicon Mac shares memory with its graphics', () => {
    const hw = toHardware(sys)
    expect(hw).toMatchObject({ os: 'darwin', arch: 'arm64', cpuModel: 'Apple M2', gpu: { kind: 'unified', name: 'Apple M2' } })
  })
  it('an 8 GB Mac reports 8.6 GB (bytes / 1e9), a 6 GB one stays under 8', () => {
    expect(toHardware(sys).totalRamGB).toBe(8.6)
    expect(toHardware({ ...sys, totalRamBytes: 6e9 }).totalRamGB).toBe(6)
  })
  it('rounds free disk to one decimal', () => {
    expect(toHardware(sys).freeDiskGB).toBe(123.5)
  })
})

describe('graphics on Windows and Linux (the notes engine checks the card)', () => {
  const pc = { platform: 'win32', arch: 'x64', cpuModel: 'Intel Core i7-12700H', totalRamBytes: 32e9, freeDiskGB: 200 }
  it('a graphics card with its own memory', () => {
    expect(toHardware(pc, { gpuType: 'cuda', vramTotalGB: 8.04, unifiedGB: 0, gpuNames: ['NVIDIA GeForce RTX 4060 Laptop GPU'] }).gpu)
      .toEqual({ kind: 'discrete', name: 'NVIDIA GeForce RTX 4060 Laptop GPU', vramGB: 8 })
  })
  it('graphics that share the memory', () => {
    expect(toHardware(pc, { gpuType: 'vulkan', vramTotalGB: 16, unifiedGB: 16, gpuNames: ['Intel(R) Iris(R) Xe Graphics'] }).gpu.kind).toBe('unified')
  })
  it('a graphics card next to graphics built into the processor counts as the card, with its own memory (#37)', () => {
    // node-llama-cpp adds the card's 12 GB to the shared memory the built-in graphics can use
    expect(toHardware(pc, { gpuType: 'vulkan', vramTotalGB: 67.8, unifiedGB: 55.8, gpuNames: ['NVIDIA GeForce RTX 4070 Ti', 'AMD Radeon(TM) Graphics'] }).gpu)
      .toEqual({ kind: 'discrete', name: 'NVIDIA GeForce RTX 4070 Ti', vramGB: 12 })
  })
  it('no usable graphics, or a check that failed: the processor only', () => {
    expect(toHardware(pc, { gpuType: false, vramTotalGB: 0, unifiedGB: 0, gpuNames: [] }).gpu).toEqual({ kind: 'none', name: '', vramGB: 0 })
    expect(toHardware(pc, null).gpu.kind).toBe('none')
  })
  it('a Mac never asks', () => {
    expect(toHardware(sys, { gpuType: false, vramTotalGB: 0, unifiedGB: 0, gpuNames: [] }).gpu).toEqual({ kind: 'unified', name: 'Apple M2', vramGB: 0 })
  })
})

describe('processor cores', () => {
  it('Windows and Linux count them (whisper on the processor needs enough); a Mac is left as it was', () => {
    expect(toHardware({ ...sys, platform: 'linux', cores: 6 }, null).cores).toBe(6)
    expect(toHardware({ ...sys, cores: 8 }).cores).toBeUndefined()
  })
})

describe('the hardware line setup shows', () => {
  it('an Apple Silicon Mac: processor, the memory people know it has, and Metal', () => {
    const hw = toHardware({ ...sys, totalRamBytes: 17_179_869_184 })
    expect(hardwareLine(hw)).toBe('Apple M2, 16 GB, Metal')
  })
  it('a graphics card with its own memory: its name and the GB on its box', () => {
    const hw = toHardware({ platform: 'win32', arch: 'x64', cpuModel: 'Intel Core i7-12700H', totalRamBytes: 34_359_738_368, freeDiskGB: 200 },
      { gpuType: 'cuda', vramTotalGB: 12, unifiedGB: 0, gpuNames: ['NVIDIA GeForce RTX 3060'] })
    expect(hardwareLine(hw)).toBe('NVIDIA GeForce RTX 3060, 12 GB VRAM')
  })
  it('graphics that share the memory say so', () => {
    const hw = toHardware({ platform: 'linux', arch: 'x64', cpuModel: 'Intel Core i7-12700H', totalRamBytes: 17_179_869_184, freeDiskGB: 200 },
      { gpuType: 'vulkan', vramTotalGB: 16, unifiedGB: 16, gpuNames: ['Intel(R) Iris(R) Xe Graphics'] })
    expect(hardwareLine(hw)).toBe('Intel Core i7-12700H, 16 GB, shared graphics')
  })
  it('no graphics at all: the processor only', () => {
    expect(hardwareLine(toHardware({ platform: 'linux', arch: 'x64', cpuModel: 'Intel Core i3', totalRamBytes: 8_589_934_592, freeDiskGB: 200 }, null)))
      .toBe('Processor only')
  })
})
