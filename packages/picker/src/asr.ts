import type { AsrChoice, Catalog, CatalogAsr, Hardware } from './types'

/**
 * The speech model for this Mac: the best one whose memory need fits (turbo on every Mac with 8 GB or more,
 * because the notes model never runs while recording on small Macs), small under that or when turbo failed
 * verification. The catalog lists them best first. Last-resort models are for the Windows and Linux speed check only.
 */
export function pickAsr(hw: Hardware, c: Catalog, opts: { exclude?: string[] } = {}): AsrChoice {
  const all = c.asr.filter((a) => !a.lastResort)
  const usable = all.filter((a) => !opts.exclude?.includes(a.id))
  const list = usable.length ? usable : all
  // Windows and Linux without graphics: whisper runs on the processor, where only the small model keeps up (a Mac always has them)
  const cpuOnly = hw.os !== 'darwin' && hw.gpu.kind === 'none'
  const fits = list.filter((a) => a.minMemGB <= hw.totalRamGB).sort((a, b) => (cpuOnly ? a.minMemGB - b.minMemGB : 0))
  const model = fits[0] ?? [...list].sort((a, b) => a.minMemGB - b.minMemGB)[0]
  const fallback = list.find((a) => a !== model && a.minMemGB <= model.minMemGB)
  return { model, ...(fallback ? { fallback } : {}) }
}

/**
 * One meeting is two tracks (the mic and the computer's sound) read live, so a model keeps up only if its careful
 * (final) reading of a clip takes at most half the clip's length.
 */
export const KEEPS_UP_RTF = 0.5
/**
 * small may take up to 1.25 times the clip's length rather than fall back to base or tiny, which are very weak outside
 * English (#107). It lags behind live; whisper skips silence, so with each side talking about half the time a meeting's
 * transcript ends at most about a quarter of its length after the meeting does.
 */
export const LAGS_A_LITTLE_RTF = 1.25
/** part of the speed check's key: a change to how it picks measures every computer again, once */
export const SPEED_CHECK_VERSION = 'v3'
/**
 * A model that reads the clip within twice its length is good enough to transcribe a meeting from its recording after
 * it ends (#107: small on a slow processor, for languages base and tiny read poorly). The speed check times up to this.
 */
export const AFTER_MEETING_RTF = 2

/**
 * Windows and Linux: the speech models the speed check tries, best first (a Mac has none: it never measures). On the
 * processor alone turbo is left out: measured on 2 cores it took 4 to 9 times the clip's length.
 */
export function asrCandidates(hw: Hardware, c: Catalog, opts: { exclude?: string[] } = {}): CatalogAsr[] {
  if (hw.os === 'darwin') return []
  const cpuOnly = hw.gpu.kind === 'none'
  return c.asr.filter((a) => a.minMemGB <= hw.totalRamGB && !(cpuOnly && a.gpuOnly) && !opts.exclude?.includes(a.id))
}

/**
 * Times the candidates in order and keeps the first that keeps up; nothing smaller is timed after it.
 * measure gives the realtime factor (time taken over the clip's length), or null when it ran out of time.
 *
 * cpuToo: a model that is too slow on the graphics is timed on the processor too. Graphics built into the processor
 * (a Radeon 680M through Vulkan) can be slower there than the processor itself; whichever keeps up is kept (cpu: true).
 *
 * None keeps up: there is still a model, never none (a computer that once got "too slow" could not record at all). It
 * is read after the meeting instead of live (afterMeeting): the best one that read the clip within its own length,
 * else the fastest, else the smallest. A meeting is recorded either way and its transcript follows.
 *
 * weak: models poor outside English (base, tiny). When one is kept, the best model before it that read the clip within
 * AFTER_MEETING_RTF is named too (multi): meetings in other languages are read with it after they end (#107).
 */
export async function pickBySpeed<M extends { id: string }>(candidates: M[], measure: (m: M, onCpu?: boolean) => Promise<number | null>, opts: { lagsOk?: (m: M) => boolean; cpuToo?: (m: M) => boolean; weak?: (m: M) => boolean } = {}): Promise<{ model: M | null; rtf: Record<string, number | null>; cpuRtf?: Record<string, number | null>; cpu?: true; afterMeeting?: true; multi?: { model: M; cpu?: true } }> {
  const rtf: Record<string, number | null> = {}
  const cpuRtf: Record<string, number | null> = {}
  const withCpu = () => (Object.keys(cpuRtf).length ? { cpuRtf } : {})
  const keepsUp = (m: M, r: number | null) => r !== null && r <= (opts.lagsOk?.(m) ? LAGS_A_LITTLE_RTF : KEEPS_UP_RTF)
  const best = (m: M) => {
    const g = rtf[m.id] ?? Infinity, c = cpuRtf[m.id] ?? Infinity
    return { m, t: Math.min(g, c), cpu: c < g }
  }
  /** for a weak model kept: the best one before it that can read a recording after the meeting */
  const multiFor = (kept: M) => {
    if (!opts.weak?.(kept)) return {}
    const b = candidates.slice(0, candidates.indexOf(kept)).map(best).find((x) => x.t <= AFTER_MEETING_RTF)
    return b ? { multi: { model: b.m, ...(b.cpu ? { cpu: true as const } : {}) } } : {}
  }
  for (const m of candidates) {
    const r = await measure(m)
    rtf[m.id] = r
    if (keepsUp(m, r)) return { model: m, rtf, ...withCpu(), ...multiFor(m) }
    if (opts.cpuToo?.(m)) {
      const c = await measure(m, true)
      cpuRtf[m.id] = c
      if (keepsUp(m, c)) return { model: m, rtf, cpuRtf, cpu: true, ...multiFor(m) }
    }
  }
  const timed = candidates.map(best)
  const fastest = timed.filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t)[0]
  const chosen = timed.find((x) => x.t <= 1) ?? fastest ?? (candidates.length ? { m: candidates[candidates.length - 1], cpu: false } : undefined)
  if (!chosen) return { model: null, rtf }
  return { model: chosen.m, rtf, ...withCpu(), ...(chosen.cpu ? { cpu: true as const } : {}), afterMeeting: true, ...multiFor(chosen.m) }
}

/** What the speed depends on: the processor and the graphics. A different one of either and the check runs again. */
export const speedKey = (hw: Hardware): string => [SPEED_CHECK_VERSION, hw.os, hw.arch, hw.cpuModel, hw.cores ?? '', hw.gpu.kind, hw.gpu.name].join('|')
