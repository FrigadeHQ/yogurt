import { stableRelease } from '../public/marketing/stars-data.mjs'

function bulletText(text) {
  return text
    .replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/gi, (link, label) => link.includes('/compare/') ? '' : label)
    .replace(/<?https?:\/\/[^\s<>]+?\/compare\/[^\s<>]+>?/gi, '')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`/g, (_, bold, emphasis, code) => bold ?? emphasis ?? code)
    .replace(/\s+/g, ' ').trim()
}

export function releaseBullets(body) {
  const bullets = []
  let fence = '', current = ''
  function finish() {
    const text = bulletText(current)
    if (text && !/^Full Changelog\b/i.test(text)) bullets.push(text)
    current = ''
  }
  for (const line of (body ?? '').replace(/<!--[\s\S]*?(?:-->|$)/g, '').split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (fence) {
      if (marker && marker[1].startsWith(fence) && !marker[2].trim()) fence = ''
    } else if (marker) {
      finish()
      fence = marker[1]
    } else {
      const bullet = line.match(/^ {0,3}[-*+]\s+(.+)$/)
      if (bullet) { finish(); current = bullet[1] }
      else if (/^\s*(?:\*\*)?Full Changelog\b/i.test(line)) finish()
      else if (current && /^\s+\S/.test(line)) current += ' ' + line.trim()
      else finish()
    }
  }
  finish()
  return bullets
}

export function releaseHeadline(bullet) {
  // Lead with the main clause of “When you …, …”. Keep the full explanation in the bullet.
  const clause = bullet.replace(/ by @[\w-]+ in https:\/\/github\.com\/\S+\/pull\/\d+\s*$/, '')
    .replace(/^When you\b[^,]*,\s+(?=\S)/i, '')
    .split(/[.!?](?=\s|$)|[:;]\s|,\s+(?=(?:handy|so|which)\b)/, 1)[0] || bullet
  // Prefer a complete clause to a headline cut in the middle of a thought.
  const phrase = (clause.length > 72 ? clause.split(/,\s+(?=and\b|but\b)/, 1)[0] : clause)
    .replace(/\s*\(#[\d#, ]+\)$/, '')
  const short = phrase.length <= 100 ? phrase : phrase.match(/^.{1,100}(?=\s)/u)?.[0] ?? phrase.slice(0, 100)
  return (short.charAt(0).toUpperCase() + short.slice(1)).replace(/[\s.,:;!?…–—-]+$/, '')
}

export function releaseArchive(rows, overrides) {
  const written = new Map(overrides.map(row => [row.version, row]))
  const archive = new Map()
  for (const row of rows) {
    if (!stableRelease(row)) continue
    const version = row.tag_name
    const override = written.get(version)
    const changes = override?.changes ?? releaseBullets(row.body)
    if (!changes.length) continue
    archive.set(version, { version, published: row.published_at,
      headline: override?.headline ?? releaseHeadline(changes[0]), changes })
  }
  return [...archive.values()].sort((a, b) => Date.parse(b.published) - Date.parse(a.published) || b.version.localeCompare(a.version))
}
