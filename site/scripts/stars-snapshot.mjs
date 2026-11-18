import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { refreshActivity, validSnapshot } from './activity.mjs'

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
const snapshot = await refreshActivity(saved, request)
await mkdir(new URL('.', cache), { recursive: true })
const tmp = new URL('activity-' + process.pid + '.json', cache)
await writeFile(tmp, JSON.stringify(snapshot) + '\n')
await rename(tmp, cache)
if (process.argv.includes('--save')) await writeFile(baked, JSON.stringify(snapshot) + '\n')
console.log(`Project activity: ${snapshot.count} stars, ${snapshot.releases} releases, ${snapshot.latest.tag}.`)
