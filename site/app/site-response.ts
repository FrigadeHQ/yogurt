import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {renderActivity,validSnapshot} from '../scripts/activity.mjs'
import baked from '../content/activity.json'
import releases from '../content/updates.json'

export function siteResponse(html: string) {
  let activity = baked
  try {
    const cached = JSON.parse(readFileSync(join(process.cwd(), '.next/cache/activity.json'), 'utf8'))
    if (validSnapshot(cached)) activity = cached
  } catch { /* The checked-in snapshot also serves local dev and a cold build. */ }
  return new Response(renderActivity(html, activity, releases), {headers:{'Content-Type':'text/html; charset=utf-8'}})
}
