import assert from 'node:assert/strict'
import fixtures from './fixtures/github-releases.json' with { type: 'json' }
import written from '../content/updates.json' with { type: 'json' }
import saved from '../content/activity.json' with { type: 'json' }
import { githubPages, renderActivity } from './activity.mjs'
import { releaseArchive, releaseBullets, releaseHeadline } from './release-notes.mjs'
import { updatesPage } from './updates.mjs'

const [latest, network] = fixtures
const rows = releaseArchive(fixtures.toReversed(), [])
assert.deepEqual(rows.map(r => r.headline), [
  'The picker now shows which calendar each event comes from',
  'Yogurt now trusts the same certificates as your computer',
  'Ask is better at "how did it go?" questions',
  'Teams calls get their names back',
  'Google Meet names are tidier',
])
assert.deepEqual(rows[0].changes, latest.body.trim().split('\n').slice(0, 2).map(line => line.slice(2)))
assert.deepEqual(rows.map(r => r.changes.length), [2, 1, 3, 4, 2])
assert(rows.every(r => r.changes.every(text => !text.includes('/compare/') && !text.includes('Full Changelog'))))

const curated = written.find(r => r.version === network.tag_name)
const mixed = releaseArchive([latest, latest, { ...network, body: '' },
  { ...network, tag_name: 'v9.0.0', draft: true }, { ...latest, prerelease: true, tag_name: 'v9.1.0' },
  { ...latest, tag_name: 'v9.2.0', body: null }, { ...latest, tag_name: 'v9.3.0', body: '## Highlights\nA paragraph.' }],
  [curated, { ...curated, version: 'v9.0.0' }])
assert.deepEqual(mixed, [rows[0], curated])
assert.equal(releaseHeadline('Upload a file: choose a recording.'), 'Upload a file')
assert.equal(releaseHeadline('See the calendar for v0.3.53. Next sentence.'), 'See the calendar for v0.3.53')
const long = 'Review ' + 'the next saved meeting '.repeat(10).trim()
assert(long.startsWith(releaseHeadline(long) + ' '))
assert(releaseHeadline(long).length <= 100)
assert.deepEqual(releaseBullets('- Save the note.\n  **Full Changelog**: https://github.com/FrigadeHQ/yogurt/compare/a...b'), ['Save the note.'])
assert.deepEqual(releaseBullets('Heading\r\n* A **saved** note\r\n  on two lines.\r\n\r\n~~~md\n- example only\n~~~\n<!--\n- hidden\n-->\n+ Read the [guide](https://example.org/guide).\n- https://github.com/FrigadeHQ/yogurt/compare/a...b\n- **Full Changelog**: [comparison](https://example.org/compare/a...b)'), ['A saved note on two lines.', 'Read the guide.'])
const literal = releaseArchive([{ ...latest, body: '- Keep <b>this</b> & {{literal}} as text.' }], [])
const html = renderActivity(updatesPage(literal), saved, literal)
assert(html.includes('&lt;b&gt;this&lt;/b&gt; &amp; &#123;&#123;literal}}'))
assert(!html.includes('<b>this</b>'))
const pages = []
const paged = await githubPages(async url => {
  pages.push(new URL(url).searchParams.get('page'))
  return pages.length === 1 ? Array(100).fill(network) : [latest]
}, 'releases')
assert.deepEqual(pages, ['1', '2'])
assert.deepEqual(releaseArchive(paged, [curated]), mixed)
await assert.rejects(githubPages(async url => {
  if (url.endsWith('page=1')) return Array(100).fill(network)
  throw Error('HTTP 429')
}, 'releases'), /429/)
console.log('Release fixtures, headlines, overrides, filters, escaping and complete pagination passed.')
