import { pageHeader, sitePage } from './site-page.mjs'

const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const fullDate = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' })
const uiLabels = /\b(Go to that day|Show earlier lines|Restart Yogurt|New recording|Take notes|Add another calendar|Regenerate summary|Summary language|Menu bar only|Multi-language|Update ready|Delete audio|Suggested|AI apps|Settings|Restart|Later|Manage|Reload|People|Ask|Enter|Trash|Latest)\b/g

function escape(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

const githubReleases = 'https://github.com/FrigadeHQ/yogurt/releases'
function githubLink(version) {
  return `<a class="quiet-link" href="${githubReleases}/tag/${encodeURIComponent(version)}" target="_blank" rel="noopener noreferrer" aria-label="View ${escape(version)} on GitHub"><span class="link-label">View on GitHub</span><span class="link-arrow" aria-hidden="true">↗</span></a>`
}

const activityCard = `<div class="activity-board"><a class="oss-card oss-calendar updates-activity" href="${githubReleases}" target="_blank" rel="noopener noreferrer"
  aria-label="{{releases}} {{releaseNoun}}, {{weekSummary}}. View releases on GitHub (opens in a new tab).">
  <div class="oss-stat"><strong>{{releases}} {{releaseNoun}}</strong><small>{{weekSummary}}</small></div>
  <div class="oss-week" aria-hidden="true">{{bars}}</div>
  <span class="card-arrow" aria-hidden="true"><svg class="oss-arrow" fill="none" viewBox="0 0 16 16">
    <path d="M4 12 12 4M5 4h7v7" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.4"/>
  </svg></span></a></div>`

export function updatesPage(releases) {
  const byDay = new Map()
  for (const release of releases) {
    const day = release.published.slice(0, 10)
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(release)
  }
  const cards = releases.map(({ version, headline, published, changes }, i) => {
    const day = published.slice(0, 10)
    const date = new Date(published)
    const label = shortDate.format(date) + (published.slice(0, 4) === releases[0].published.slice(0, 4) ? '' : ', ' + date.getUTCFullYear())
    const dayId = byDay.get(day)[0].version === version ? ` id="day-${day}"` : ''
    const bullets = changes.map(text => '<li>' + escape(text).replace(uiLabels, '<strong>$1</strong>') + '</li>').join('')
    return `<details class="release-card" id="${escape(version)}"${i < 3 ? ' open' : ''}>
      <summary${dayId}><h2><span class="release-meta">${escape(version)} · <time datetime="${day}" title="${fullDate.format(date)}">${label}</time></span>
      <span class="release-heading">${escape(headline)}</span></h2><span class="tour-plus" aria-hidden="true"></span></summary>
      <div class="faq-answer"><ul>${bullets}</ul><p>${githubLink(version)}</p></div></details>`
  })
  const batches = []
  for (let i = 3; i < cards.length;) {
    const day = releases[i].published.slice(0, 10)
    let end = Math.min(i + 6, cards.length)
    // Finish the first archive day, then reveal six cards at a time.
    if (i === 3) while (releases[end - 1].published.slice(0, 10) !== day) end--
    batches.push('<div class="release-batch">' + cards.slice(i, end).join('') + '</div>')
    i = end
  }
  const archive = batches.length ? `<section id="earlier" aria-label="Earlier releases">${batches.join('')}</section>` : ''
  const fallback = archive ? '<div class="archive-end"><a class="link-label" href="?all=1#earlier">View all releases</a></div><p class="archive-status" role="status" aria-live="polite" aria-atomic="true"></p>' : ''
  const description = 'What’s new in Yogurt, release by release.'
  const body = `<main id="main" class="updates-page reading-page" tabindex="-1">${pageHeader('Updates')}
    <div class="updates-column">${releases.length ? activityCard : ''}
    <a class="skip skip-history" href="#footer"><span class="link-label">Skip release history</span></a><div class="faq-cards release-stack">${cards.slice(0, 3).join('')}${archive}</div>${fallback}</div></main>`
  return sitePage({ path: '/updates', title: 'Updates · Yogurt', description, body, modules: ['updates'] })
}
