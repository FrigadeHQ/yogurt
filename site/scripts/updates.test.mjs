import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { navStars } from '../public/marketing/stars-data.mjs'
import { homePage } from './site-page.mjs'
import { renderActivity } from './activity.mjs'
import { updatesPage } from './updates.mjs'

const releases = JSON.parse(readFileSync(new URL('../content/updates.json', import.meta.url)))
// A newer GitHub snapshot cannot advertise a release with no page in this build.
const snapshot = { ...JSON.parse(readFileSync(new URL('../content/activity.json', import.meta.url))),
  latest: { tag: 'v99.0.0', published: '2099-01-01T00:00:00Z' }, releases: 999999, week: Array(7).fill(0) }
const html = renderActivity(updatesPage(releases), snapshot, releases)
const home = renderActivity(homePage(), snapshot, releases)
for (const count of [2, 104, 10000, 12500]) {
  const data = { ...snapshot, count }
  const homepage = renderActivity(homePage(), data, releases)
  const updates = renderActivity(updatesPage(releases), data, releases)
  const navCount = /class="nav-stars"[^>]*>[\s\S]*?<span>([^<]+)<\/span>/
  const tileCount = Number(homepage.match(/class="stat-value">([^<]+)/)[1].replaceAll(',', ''))
  assert.equal(tileCount, count)
  assert.equal(homepage.match(navCount)[1], navStars(tileCount))
  assert.equal(updates.match(navCount)[1], navStars(count))
}
const latest = releases[0]
const end = Date.parse(latest.published.slice(0, 10))
const weekCount = releases.filter(row => Date.parse(row.published) >= end - 6 * 86400000).length
const tile = home.match(/<a class="oss-card oss-calendar"[\s\S]*?<\/a>/)[0]
const latestTile = home.match(/<a class="oss-card oss-latest"[\s\S]*?<\/a>/)[0]
assert(tile.includes('href="/updates"'))
assert(tile.includes(`class="oss-figure">${releases.length.toLocaleString('en-US')}<`))
assert(latestTile.includes(`href="/updates#${latest.version}"`))
for (const card of [tile, latestTile]) {
  assert.doesNotMatch(card, /target=|noopener|class="oss-arrow"/)
  assert(card.includes('class="link-chevron"'))
}
const releaseIndex = 'https://github.com/FrigadeHQ/yogurt/releases'
const activityCard = html.match(/<a class="oss-card oss-calendar updates-activity"[\s\S]*?<\/a>/)[0]
for (const page of [home, html]) {
  for (const [card] of page.matchAll(/<a\b[^>]*class="oss-card [^"]+"[\s\S]*?<\/a>/g)) {
    assert.doesNotMatch(card, /class="[^"]*\blink-label\b/)
  }
}
const totalLabel = releases.length.toLocaleString('en-US') + ' releases'
const summary = activityCard.match(/<small>([^<]+)<\/small>/)[1]
assert(summary.startsWith(weekCount + ' published '))
assert(tile.includes(`aria-label="${summary}"`))
assert(activityCard.includes(`<strong>${totalLabel}</strong>`))
assert.match(activityCard, /<\/div>\s*<span class="card-arrow" aria-hidden="true"><svg class="oss-arrow"/)
assert(activityCard.includes(`href="${releaseIndex}" target="_blank" rel="noopener noreferrer"`))
assert(activityCard.includes(`aria-label="${totalLabel}, ${summary}. View releases on GitHub (opens in a new tab)."`))
assert(activityCard.includes('class="oss-week" aria-hidden="true"'))
assert.equal(activityCard.match(/<a\b/g).length, 1)
assert.doesNotMatch(activityCard, /<button\b|tabindex=/)
assert.doesNotMatch(html, /All releases on GitHub|href="#day-/)
const barTitles = markup => [...markup.matchAll(/<span class="week-day" title="([^"]+)"/g)].map(m => m[1])
assert.equal(barTitles(activityCard).length, 7)
assert.deepEqual(barTitles(activityCard), barTitles(tile))
const cards = html.match(/<details class="release-card"[\s\S]*?<\/details>/g)
assert.equal(cards.length, releases.length)
assert.equal(new Set(releases.map(r => r.version)).size, releases.length)
for (const [i, card] of cards.entries()) {
  const row = releases[i]
  assert.match(row.version, /^v\d+\.\d+\.\d+$/)
  assert.equal(new Date(row.published).toISOString().slice(0, 19), row.published.slice(0, 19))
  if (i) assert(releases[i-1].published >= row.published)
  assert(row.headline.length && row.changes.length)
  assert(row.changes.every(line => line.length <= 62))
  assert(card.startsWith(`<details class="release-card" id="${row.version}"${i < 3 ? ' open' : ''}>`))
  assert(card.includes(`<span class="release-meta">${row.version} · <time`))
  assert.equal(card.match(/<a\b/g)?.length, 1)
  assert.doesNotMatch(card.split('</summary>')[0], /<a\b|tabindex=/)
  const source = `href="${releaseIndex}/tag/${row.version}" target="_blank" rel="noopener noreferrer"`
  assert(card.split('</summary>')[1].includes(source))
  assert(!card.split('</summary>')[0].includes(source))
  assert.equal(card.match(/<li>/g).length, row.changes.length)
  assert.doesNotMatch(card, /<(img|picture|video|figure|iframe|svg)\b/)
}
for (const day of new Set(releases.map(row => row.published.slice(0, 10)))) {
  assert(html.includes(`id="day-${day}"`), 'Existing day bookmarks should still resolve')
}
assert(html.includes('href="?all=1#earlier"'))
assert(!html.includes('hidden="until-found"'))
for (const page of [html, home]) {
  const nav = page.match(/<header class="site-header">[\s\S]*?<\/header>/)[0]
  assert(!nav.includes('/updates'))
  const footer = page.match(/<footer[\s\S]*?<\/footer>/)[0]
  assert.equal(footer.match(/href="\/updates"/g)?.length, 1)
  for (const [, url] of page.matchAll(/href="(https:\/\/github\.com\/FrigadeHQ\/yogurt\/releases[^"]*)"/g)) {
    if (url.includes('/download/')) continue
    assert(page === html && (url === releaseIndex || releases.some(row => url === releaseIndex + '/tag/' + row.version)), url)
  }
}
assert(!html.includes('data-hero-entry="pending"'))
assert(html.includes('href="/#questions"'))
const unsafe = updatesPage([{ ...releases[0], headline: 'Read <this>', changes: ['Go to Settings & choose <Audio>.'] }])
assert(unsafe.includes('Read &lt;this&gt;'))
assert(unsafe.includes('<strong>Settings</strong> &amp; choose &lt;Audio&gt;'))
console.log(`${cards.length} text-only releases, defaults, deep-link IDs, release links, chart, shared navigation and footer passed.`)
