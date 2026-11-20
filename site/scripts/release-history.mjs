import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import written from '../content/updates.json' with { type: 'json' }

// The build writes one snapshot before Next prerenders any routes. A fresh dev checkout uses the archive.
function readHistory() {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), '.next/cache/updates.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return written
    throw error
  }
}

export default readHistory()
