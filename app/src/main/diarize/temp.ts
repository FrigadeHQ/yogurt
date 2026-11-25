import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The prefix of every diarization run's temp dir, and of nothing else. A crash or quit mid-run leaves the
 * run's wav behind; startup sweeps it away. It must stay this narrow: `yogurt-diarize-` alone also matched
 * profiles and test data other things create (`yogurt-diarize-e2e-…`), and a sweep that deletes a profile
 * takes the person's settings with it.
 */
export const DIARIZE_TMP_PREFIX = 'yogurt-diarize-run-'

/** Remove the runs' leftover temp dirs from dir (tmpdir): nothing in them is anyone's data, only a decode's wav. */
export function sweepDiarizeTemp(dir: string): string[] {
  let names: string[]
  try { names = readdirSync(dir).filter((n) => n.startsWith(DIARIZE_TMP_PREFIX)) } catch { return [] }
  const swept: string[] = []
  for (const name of names) {
    try { rmSync(join(dir, name), { recursive: true, force: true }); swept.push(name) } catch { /* left for the next start */ }
  }
  return swept
}
