import { repoAPI as api, stableRelease, navStars } from '../public/marketing/stars-data.mjs'
const hour = 3600000,
  day = hour * 24
const timestamp = (value) => Number.isFinite(Date.parse(value))
const version = (value) => typeof value === 'string' && /^v[\w.-]+$/.test(value)

export function validSnapshot(data) {
  return (
    !!data &&
    timestamp(data.capturedAt) &&
    timestamp(data.historyCapturedAt) &&
    Number.isSafeInteger(data.count) &&
    data.count > 0 &&
    Number.isSafeInteger(data.releases) &&
    data.releases > 0 &&
    version(data.latest?.tag) &&
    timestamp(data.latest.published) &&
    Array.isArray(data.week) && data.week.length === 7 &&
    data.week.every((n) => Number.isInteger(n) && n >= 0) &&
    Array.isArray(data.history) &&
    data.history.length > 0 &&
    data.history.every(
      (point, i) =>
        Array.isArray(point) &&
        point.length === 2 &&
        Number.isFinite(point[0]) &&
        Number.isSafeInteger(point[1]) &&
        point[1] > 0 &&
        (!i || (point[0] > data.history[i - 1][0] && point[1] > data.history[i - 1][1]))
    )
  )
}

// Store only timestamps and cumulative counts. No account information goes in the snapshot.
export function historyFromDates(dates) {
  const points = []
  dates
    .sort((a, b) => a - b)
    .forEach((time, i) => {
      const last = points.at(-1)
      if (last && Math.floor(last[0] / hour) === Math.floor(time / hour)) {
        last[0] = time
        last[1] = i + 1
      } else points.push([time, i + 1])
    })
  return points
}
export async function getActivity(saved, request, now = new Date()) {
  async function pages(endpoint, accept) {
    const rows = []
    for (let page = 1; ; page++) {
      const batch = await request(api + '/' + endpoint + '?per_page=100&page=' + page, accept)
      if (!Array.isArray(batch)) throw Error('Incomplete page')
      rows.push(...batch)
      if (batch.length < 100) return rows
    }
  }
  const repo = await request(api)
  if (!Number.isSafeInteger(repo.stargazers_count) || repo.stargazers_count < 1)
    throw Error('Invalid star count')
  const releases = (await pages('releases'))
    .filter(stableRelease)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
  if (!releases.length) throw Error('No published releases')
  const today = Date.parse(now.toISOString().slice(0, 10))
  const week = Array(7).fill(0)
  for (const release of releases) {
    const index = 6 + Math.floor((Date.parse(release.published_at) - today) / day)
    if (index >= 0 && index < 7) week[index]++
  }
  let history = saved?.history
  let historyCapturedAt = saved?.historyCapturedAt
  if (
    !validSnapshot(saved) ||
    saved.history.at(-1)[1] !== repo.stargazers_count ||
    !(now - Date.parse(historyCapturedAt) < day)
  ) {
    try {
      const stars = await pages('stargazers', 'application/vnd.github.star+json')
      const dates = new Map()
      for (const row of stars) {
        if (!row.user?.id || !timestamp(row.starred_at)) throw Error('Invalid star timestamp')
        dates.set(row.user.id, Date.parse(row.starred_at))
      }
      if (!dates.size) throw Error('No star history')
      history = historyFromDates([...dates.values()])
      historyCapturedAt = now.toISOString()
    } catch (error) {
      if (!validSnapshot(saved)) throw error
      console.warn('Using cached star history from ' + historyCapturedAt)
    }
  }
  const snapshot = {
    capturedAt: now.toISOString(),
    count: repo.stargazers_count,
    history,
    historyCapturedAt,
    releases: releases.length,
    week,
    latest: { tag: releases[0].tag_name, published: new Date(releases[0].published_at).toISOString() },
  }
  if (!validSnapshot(snapshot)) throw Error('Invalid activity snapshot')
  return snapshot
}
function releaseFields(releases) {
  const latest = releases[0]
  const end = Date.parse(latest.published.slice(0, 10))
  const first = end - 6 * day
  const counts = Array(7).fill(0)
  for (const { published } of releases) {
    const index = (Date.parse(published.slice(0, 10)) - first) / day
    if (index >= 0 && index < 7) counts[index]++
  }
  const date = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' })
  const peak = Math.max(1, ...counts)
  const bars = counts.map((count, i) => {
    const when = new Date(first + i * day)
    const label = date.format(when) + ', ' + count + (count === 1 ? ' release' : ' releases')
    return `<span class="week-day" title="${label}"><i><b style="height:${100 * count / peak}%"></b></i><small>${weekday.format(when)}</small></span>`
  }).join('')
  const weekTotal = counts.reduce((sum, count) => sum + count, 0)
  return {
    releases: releases.length.toLocaleString('en-US'),
    releaseNoun: releases.length === 1 ? 'release' : 'releases',
    weekSummary: `${weekTotal} published ${date.formatRange(first, end)}`,
    bars,
    version: latest.version, published: latest.published,
    releaseDate: new Date(latest.published).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    }),
  }
}

export function renderActivity(html, data, releases) {
  const format = new Intl.NumberFormat('en-US')
  const { count, history } = data
  // The total may have refreshed even when dated history was unavailable.
  const last = history.at(-1)
  const observedAt = Date.parse(data.capturedAt)
  const points = count !== last[1] && observedAt > last[0] ? [...history, [observedAt, count]] : history
  const start = points[0][0], span = points.at(-1)[0] - start
  const maximum = Math.max(count, last[1])
  const vertices = points.map(([time, stars]) => {
    const x = span ? 510 * (time - start) / span : 510
    const y = 90 - 90 * stars / maximum
    return x.toFixed(2) + ',' + y.toFixed(2)
  })
  const values = {
    capturedAt: data.capturedAt,
    stars: format.format(count),
    navStars: navStars(count),
    vertices: vertices.join(' '),
    area: 'M' + vertices.join('L') + (span ? 'L510 90L0 90Z' : 'L510 90Z'),
    ...releaseFields(releases),
    historyLabel: `${format.format(last[1])} dated stars through ${new Date(history.at(-1)[0])
      .toISOString()
      .slice(0, 10)}`,
  }
  return html.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw Error('Unknown activity field ' + key)
    return String(values[key])
  })
}

export async function refreshActivity(saved, request, now) {
  try {
    return await getActivity(saved, request, now)
  } catch (error) {
    if (!validSnapshot(saved)) throw error
    console.warn('Using saved project activity from ' + saved.capturedAt + ' (' + error.message + ').')
    return saved
  }
}
