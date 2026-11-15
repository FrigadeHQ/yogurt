// Transcript lab end to end on this computer, opt-in (it runs the real models):
//   LAB_E2E_USERDATA=<Yogurt's profile folder> LAB_E2E_DB=<copy of yogurt.db> LAB_E2E_MEETING=<id> npx vitest run test/labE2E.test.ts
// Reads <profile>/transcript-lab.json and the meeting's recording there; changes only the database copy given.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openStore } from '../src/main/store'
import { labFile, readLab } from '../src/main/lab/config'
import { createTranscriptLab } from '../src/main/lab/index'

const db = process.env.LAB_E2E_DB, id = process.env.LAB_E2E_MEETING
const userData = process.env.LAB_E2E_USERDATA ?? ''

describe.skipIf(!db || !id || !userData)('lab end to end', () => {
  it('reads a real meeting with every model, combines, shows it and goes back', async () => {
    const store = openStore(db!)
    const line = () => store.segments(id!).map((s) => `${s.track}@${s.startMs}: ${s.text}`)
    const before = line()
    const cfg = labFile(userData)
    const lab = createTranscriptLab({ store, config: () => readLab(cfg), live: () => false, dirOf: (m) => join(userData, 'meetings', m),
      exts: ['ogg', 'm4a', 'wav'], busy: () => false, changed: () => {}, log: (l) => console.log('lab:', l) })
    const t0 = Date.now()
    lab.run(id!)
    while (!['done', 'failed'].includes(lab.view(id!).status.state)) await new Promise((r) => setTimeout(r, 500))
    const v = lab.view(id!)
    console.log(`${v.status.state}${v.status.error ? `: ${v.status.error}` : ''} in ${((Date.now() - t0) / 1000).toFixed(0)} s, showing ${v.status.using}`)
    for (const w of v.windows) {
      console.log(`\n[${w.key} ${w.language}] live: ${w.texts.join(' ')}`)
      for (const m of v.models) if (v.readings[m.id]?.[w.key] !== undefined) console.log(`  ${m.id.padEnd(18)} ${v.readings[m.id][w.key]}`)
      console.log(`  ${'COMBINED'.padEnd(18)} ${w.combined}`)
    }
    console.log('\nnow shown:\n' + line().join('\n'))
    expect(v.status.state).toBe('done')
    expect(v.status.using).toBe('combined')
    lab.use(id!, 'live')
    expect(line()).toEqual(before)
  }, 900_000)
})
