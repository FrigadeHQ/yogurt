import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

/**
 * Runs the two local tools of a diarization job: the recorder helper's decode (m4a on a Mac, Ogg Opus on
 * Windows and Linux) and nemo-speech's diarize. Backends: metal on a Mac, vulkan elsewhere, cpu everywhere;
 * an accelerator that fails to start falls back to cpu once. Only backend names land in the log; the
 * failure's detail travels in the rejection, never in the log.
 */
export type Backend = 'cpu' | 'vulkan' | 'metal'

export function probeBackend(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): Backend {
  const asked = env.YOGURT_DIARIZE_BACKEND as Backend | undefined
  if (asked === 'cpu' || asked === 'vulkan' || asked === 'metal') return asked
  return platform === 'darwin' ? 'metal' : 'vulkan'
}

/** a stuck child is killed well after the audio itself could have been processed (model load included) */
export const diarizeTimeoutMs = (audioMs: number): number => Math.max(180_000, Math.round(audioMs * 8) + 120_000)

const exec = (cmd: string, args: string[], timeoutMs: number): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr?.on('data', (d: Buffer) => { err += d.toString() })
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} timed out after ${timeoutMs} ms`)) }, timeoutMs)
  child.on('error', (e) => { clearTimeout(timer); reject(e) })
  child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${cmd} failed (${code}): ${err.trim().slice(0, 400)}`)) })
})

/** the meeting's them file as 16 kHz mono wav in a temp dir (m4a via AVFoundation on a Mac, Ogg Opus elsewhere) */
export async function runDecode(helper: string, input: string, out: string, timeoutMs = 120_000): Promise<void> {
  await exec(helper, ['decode', '--in', input, '--out', out], timeoutMs)
}

/** RTTM into rttmPath. Returns which backend won; a failed accelerator is retried once on the cpu. */
export async function runDiarize(nemo: string, wav: string, model: string, rttmPath: string, backend: Backend, timeoutMs?: number): Promise<'gpu' | 'cpu'> {
  const cap = timeoutMs ?? diarizeTimeoutMs(0)
  const once = (device: string) => exec(nemo, ['diarize', wav, '--model', model, '--format', 'rttm', '--output', rttmPath, '--device', device], cap)
  if (backend === 'cpu') { await once('cpu'); return 'cpu' }
  try {
    await once(backend)
    console.info(`DIARIZE backend: ${backend}`)
    return 'gpu'
  } catch {
    console.warn(`DIARIZE ${backend} failed, trying the cpu`)
    await once('cpu')
    console.info('DIARIZE backend: cpu')
    return 'cpu'
  }
}
