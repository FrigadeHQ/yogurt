import { describe, expect, it } from 'vitest'
import { integratedGpu, toHardware } from '../src/main/hardware'

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
  it('the card is named for the card, whichever order the graphics come in: never the built-in Iris Xe (#165)', () => {
    expect(toHardware(pc, { gpuType: 'vulkan', vramTotalGB: 21.2, unifiedGB: 17.0, gpuNames: ['Intel(R) Iris(R) Xe Graphics', 'NVIDIA RTX A2000 Laptop GPU'] }).gpu)
      .toEqual({ kind: 'discrete', name: 'NVIDIA RTX A2000 Laptop GPU', vramGB: 4.2 })
    expect(toHardware(pc, { gpuType: 'vulkan', vramTotalGB: 24, unifiedGB: 16, gpuNames: ['AMD Radeon(TM) 780M', 'AMD Radeon RX 7600M XT'] }).gpu.name).toBe('AMD Radeon RX 7600M XT')
  })
  it('built-in graphics alone are never called a card, even when none of their memory shows as shared (#165)', () => {
    expect(toHardware(pc, { gpuType: 'vulkan', vramTotalGB: 16, unifiedGB: 0, gpuNames: ['Intel(R) Iris(R) Xe Graphics'] }).gpu).toEqual({ kind: 'unified', name: 'Intel(R) Iris(R) Xe Graphics', vramGB: 16 })
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

describe('graphics built into the processor, by name (#165)', () => {
  it.each(['Intel(R) Iris(R) Xe Graphics', 'Intel(R) UHD Graphics 770', 'Intel(R) HD Graphics 620', 'Intel(R) Graphics', 'Intel(R) Arc(TM) Graphics', 'AMD Radeon(TM) Graphics', 'AMD Radeon 780M Graphics', 'AMD Radeon(TM) 890M', 'AMD Radeon Vega 8 Graphics', 'AMD Radeon Graphics (RADV RENOIR)', 'llvmpipe (LLVM 17.0.6, 256 bits)'])('%s is built in', (name) => {
    expect(integratedGpu(name)).toBe(true)
  })
  it.each(['NVIDIA RTX A2000 Laptop GPU', 'NVIDIA GeForce RTX 4060 Laptop GPU', 'AMD Radeon RX 7900 XTX', 'AMD Radeon RX 7600M XT', 'AMD Radeon Pro W6800', 'Intel(R) Arc(TM) A770 Graphics', 'Intel(R) Arc(TM) B580 Graphics', 'Intel(R) Arc(TM) A370M Graphics'])('%s is a card', (name) => {
    expect(integratedGpu(name)).toBe(false)
  })
})
