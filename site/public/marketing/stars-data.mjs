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
    if (saved?.latest && /^v[\w.-]+$/.test(saved.latest.tag) &&
        Date.parse(saved.latest.published) >= Date.parse(built.latest.published)) {
      data.latest = saved.latest
      if (validCount(saved.releases) && saved.releases > 0) data.releases = saved.releases
    }
    if (now - cached.at < hour) return data
  }
  // Keep one request per field and per cache window, even after a rate limit.
  function save() {
    try { storage.setItem(cacheKey, JSON.stringify({ builtAt: built.capturedAt, at: now, data })) } catch {}
  }
  save()
  const list = built.releases < 100
  const [repo, release] = await Promise.allSettled([
    getJSON(repoAPI), getJSON(repoAPI + (list ? '/releases?per_page=100' : '/releases/latest')),
  ])
  if (repo.status === 'fulfilled' && validCount(repo.value?.stargazers_count)) data.count = repo.value.stargazers_count
  if (release.status === 'fulfilled') {
    const rows = list ? release.value : [release.value]
    if (Array.isArray(rows)) {
      const published = rows.filter(stableRelease).sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
      const latest = published[0]
      if (latest && Date.parse(latest.published_at) >= Date.parse(data.latest.published)) {
        data.latest = { tag: latest.tag_name, published: latest.published_at }
        // A full page could be partial. The build paginates to get the exact total.
        if (list && rows.length < 100) data.releases = published.length
      }
    }
  }
  save()
  return data
}
