export const repoAPI = 'https://api.github.com/repos/FrigadeHQ/yogurt'
const cacheKey = 'yogurt-github-activity-v1'
export const hour = 60 * 60 * 1000
const compact = new Intl.NumberFormat('en', {notation:'compact', maximumSignificantDigits:3})
export const navStars = count => count < 10000 ? count.toLocaleString('en') : compact.format(count)
const validCount = value => Number.isSafeInteger(value) && value >= 0
export const stableRelease = row => row && !row.draft && !row.prerelease &&
  typeof row.tag_name === 'string' && /^v[\w.-]+$/.test(row.tag_name) && Number.isFinite(Date.parse(row.published_at))

export async function refreshSummary(built, { storage, getJSON, now = Date.now() }) {
  let cached
  try { cached = JSON.parse(storage.getItem(cacheKey)) } catch {}
  const data = { ...built }
  // A new deployment can be fresher than a visitor's cache, including after a failed request.
  if (cached?.builtAt === built.capturedAt && Number.isFinite(cached.at) && now >= cached.at) {
    const saved = cached.data
    if (validCount(saved?.count)) data.count = saved.count
    if (now - cached.at < hour) return data
  }
  // Keep one request per cache window, even after a rate limit.
  function save() {
    try { storage.setItem(cacheKey, JSON.stringify({ builtAt: built.capturedAt, at: now, data })) } catch {}
  }
  save()
  try {
    const repo = await getJSON(repoAPI)
    if (validCount(repo?.stargazers_count)) data.count = repo.stargazers_count
  } catch { /* Keep the cached or build-time star count. */ }
  save()
  return data
}
