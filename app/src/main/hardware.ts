import os from 'node:os'
import type { Hardware, OS } from '@yogurt/picker'
import { realDeps } from './downloader'

export type SysInfo = { platform: string; arch: string; cpuModel: string; totalRamBytes: number; freeDiskGB: number; cores?: number }

/** What the notes engine found (node-llama-cpp): the graphics it can use, their memory, their names. gpuType false: none */
export type GpuProbe = { gpuType: string | false; vramTotalGB: number; unifiedGB: number; gpuNames: string[] }

/**
 * A Mac (Apple Silicon) shares memory with its graphics: no probe needed, as always. Windows and Linux ask the notes
 * engine what it can use: a card with its own memory, graphics sharing the memory, or none (also when the
 * check failed or crashed: then the processor alone).
 */
export function toHardware(sys: SysInfo, probe?: GpuProbe | null): Hardware {
  const mac = sys.platform === 'darwin'
  // A card next to graphics built into the processor: node-llama-cpp adds the card's memory to the shared memory, but
  // llama.cpp runs on the card, so it's a card with what's left once the shared part is taken out (#37)
  const ownGB = probe ? probe.vramTotalGB - probe.unifiedGB : 0
  const kind = mac ? 'unified' : !probe?.gpuType ? 'none' : probe.unifiedGB > 0 && ownGB < 2 ? 'unified' : 'discrete'
  return {
    os: sys.platform as OS,
    arch: sys.arch,
    cpuModel: sys.cpuModel,
    totalRamGB: Math.round((sys.totalRamBytes / 1e9) * 10) / 10,
    freeDiskGB: Math.round(sys.freeDiskGB * 10) / 10,
    gpu: mac ? { kind, name: sys.cpuModel, vramGB: 0 }
      : { kind, name: kind === 'none' ? '' : probe?.gpuNames[0] ?? '', vramGB: kind === 'none' ? 0 : Math.round((kind === 'discrete' ? ownGB : probe?.vramTotalGB ?? 0) * 10) / 10 },
    ...(!mac && sys.cores ? { cores: sys.cores } : {}),
  }
}

export async function readSysInfo(diskDir: string): Promise<SysInfo> {
  return {
    platform: process.platform, arch: process.arch,
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    cores: os.availableParallelism(),
    totalRamBytes: os.totalmem(),
    freeDiskGB: await realDeps.freeDiskGB(diskDir),
  }
}

/** decimal GB (bytes / 1e9, as total memory is read) as the whole GB people know: 17.2 is a 16 GB Mac */
export const wholeGB = (gb: number) => Math.round(gb / 1.073741824)

/**
 * The hardware line setup shows in plain language: what the computer is, how much memory it works with, and what
 * makes the model fast. Example: "Apple M2, 16 GB, Metal", "NVIDIA RTX 3060, 12 GB VRAM", or "Processor only".
 */
export function hardwareLine(hw: Hardware): string {
  // a card's memory is already reported as the GB on its box (12 for a 12 GB card); total memory is bytes / 1e9
  if (hw.gpu.kind === 'discrete') return `${hw.gpu.name}, ${Math.round(hw.gpu.vramGB)} GB VRAM`
  if (hw.gpu.kind === 'unified') return `${hw.cpuModel}, ${wholeGB(hw.totalRamGB)} GB, ${hw.os === 'darwin' ? 'Metal' : 'shared graphics'}`
  return 'Processor only'
}
