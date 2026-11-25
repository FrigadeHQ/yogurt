import os from 'node:os'
import type { Hardware, OS } from '@yogurt/picker'
import { realDeps } from './downloader'

export type SysInfo = { platform: string; arch: string; cpuModel: string; totalRamBytes: number; freeDiskGB: number; cores?: number }

/** What the notes engine found (node-llama-cpp): the graphics it can use, their memory, their names. gpuType false: none */
export type GpuProbe = { gpuType: string | false; vramTotalGB: number; unifiedGB: number; gpuNames: string[] }

/**
 * Graphics built into the processor, by the name the engine reports (it gives names, not kinds). Intel's Iris, UHD, HD
 * and plain "Graphics" (an Arc without a model number is built in; an A770 or B580 is a card), AMD's Radeon Graphics,
 * Vega and 680M-890M, and the software renderer.
 */
export const integratedGpu = (name: string): boolean =>
  /\bIntel\b.*\b(Iris|UHD|HD Graphics)\b/i.test(name) || /^Intel(\(R\))? Graphics\b/i.test(name)
  || (/\bIntel\b.*\bArc\b/i.test(name) && !/\b[AB]\d{3}M?\b/.test(name))
  || /\bRadeon(\(TM\))?( Vega \d+)? Graphics\b/i.test(name) || /\bRadeon(\(TM\))? \d{3}M\b/i.test(name)
  || /^llvmpipe\b/i.test(name)

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
  // names that are all built-in graphics are never called a card, whatever the memory says (#165)
  const builtIn = !!probe?.gpuNames.length && probe.gpuNames.every(integratedGpu)
  const kind = mac ? 'unified' : !probe?.gpuType ? 'none' : builtIn || (probe.unifiedGB > 0 && ownGB < 2) ? 'unified' : 'discrete'
  return {
    os: sys.platform as OS,
    arch: sys.arch,
    cpuModel: sys.cpuModel,
    totalRamGB: Math.round((sys.totalRamBytes / 1e9) * 10) / 10,
    freeDiskGB: Math.round(sys.freeDiskGB * 10) / 10,
    gpu: mac ? { kind, name: sys.cpuModel, vramGB: 0 }
      // the card by name, never the built-in graphics next to it, whichever comes first (#165)
      : { kind, name: kind === 'none' ? '' : (kind === 'discrete' && probe?.gpuNames.find((n) => !integratedGpu(n))) || (probe?.gpuNames[0] ?? ''), vramGB: kind === 'none' ? 0 : Math.round((kind === 'discrete' ? ownGB : probe?.vramTotalGB ?? 0) * 10) / 10 },
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
