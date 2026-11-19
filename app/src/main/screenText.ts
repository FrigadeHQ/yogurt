import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export type ScreenLine = { ms: number; text: string }

/** An uploaded video's screen as text (yogurt-audio screen-text, on a Mac): what was shown, at the time it was shown */
export async function readScreen(binary: string, file: string, progress: (fraction: number) => void, signal: AbortSignal): Promise<ScreenLine[]> {
  const child = spawn(binary, ['screen-text', file], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal })
  let err = ''
  child.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-500) })
  const closed = new Promise<number | null>((resolve, reject) => { child.on('close', resolve); child.on('error', reject) })
  const lines: ScreenLine[] = []
  for await (const row of createInterface({ input: child.stdout })) {
    const o = JSON.parse(row) as { ms?: unknown; text?: unknown; fraction?: unknown }
    if (typeof o.fraction === 'number') progress(o.fraction)
    else if (typeof o.ms === 'number' && Number.isFinite(o.ms) && o.ms >= 0 && typeof o.text === 'string' && o.text.trim()) lines.push({ ms: o.ms, text: o.text.trim() })
  }
  const code = await closed
  if (code !== 0) throw new Error(`reading the screen of ${file} failed (${code}): ${err.trim()}`)
  return lines
}
