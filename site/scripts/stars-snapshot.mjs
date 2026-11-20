import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import written from '../content/updates.json' with { type: 'json' }
import { releaseArchive } from './release-notes.mjs'
import { githubPages, refreshActivity, validSnapshot } from './activity.mjs'

const baked = new URL('../content/activity.json', import.meta.url)
const cache = new URL('../.next/cache/activity.json', import.meta.url)
async function read(url) {
  try {
    const value = JSON.parse(await readFile(url, 'utf8'))
    if (validSnapshot(value)) return value
  } catch {}
}
const saved = [await read(cache), await read(baked)]
  .filter(Boolean)
  .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))[0]
async function request(url, accept = 'application/vnd.github+json') {
  if (process.argv.includes('--save'))
    return JSON.parse(execFileSync('gh', ['api', '-H', 'Accept: ' + accept, url], { encoding: 'utf8' }))
  const headers = { Accept: accept }
  if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(6000) })
  if (!response.ok) throw Error('GitHub returned ' + response.status)
  return response.json()
}
// Release notes and activity share one paginated API read. A partial fetch cannot replace the archive.
let rows = []
let releases = written
try {
  rows = await githubPages(request, 'releases')
  const archive = releaseArchive(rows, written)
  if (!archive.length) throw Error('No published release notes')
  releases = archive
  console.log(`Updates: ${releases.length} releases through ${releases[0].version} from GitHub and editorial overrides.`)
} catch (error) {
  console.warn(`Updates: using committed content/updates.json (${error.message}).`)
}
const snapshot = await refreshActivity(saved, request, new Date(), rows)
await mkdir(new URL('.', cache), { recursive: true })
const notesTmp = new URL('updates-' + process.pid + '.json', cache)
await writeFile(notesTmp, JSON.stringify(releases) + '\n')
await rename(notesTmp, new URL('updates.json', cache))
const tmp = new URL('activity-' + process.pid + '.json', cache)
await writeFile(tmp, JSON.stringify(snapshot) + '\n')
await rename(tmp, cache)
if (process.argv.includes('--save')) await writeFile(baked, JSON.stringify(snapshot) + '\n')
console.log(`Project activity: ${snapshot.count} stars, ${snapshot.releases} releases, ${snapshot.latest.tag}.`)
