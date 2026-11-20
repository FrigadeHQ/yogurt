import assert from 'node:assert/strict'
import releases from '../content/updates.json' with { type: 'json' }
import { homePage } from './site-page.mjs'
import { homeStructuredData } from './home-metadata.mjs'
import { updatesPage } from './updates.mjs'

const html = homePage()
const jsonLd = /<script type="application\/ld\+json">([^]*?)<\/script>/g
const scripts = [...html.split('</head>')[0].matchAll(jsonLd)]
assert.equal(scripts.length, 1)
const graph = JSON.parse(scripts[0][1])['@graph']
const app = graph.find(node => node['@type'] === 'SoftwareApplication')
const organization = graph.find(node => node['@type'] === 'Organization')
const questions = graph.find(node => node['@type'] === 'FAQPage').mainEntity
assert.equal(app.description, html.match(/<meta content="([^"]+)" name="description"/)[1])
assert.equal(app.softwareVersion, releases[0].version)
assert.equal(app.offers.price, 0)
assert.equal(app.license.name, 'MIT License')
assert.equal(organization.name, 'Frigade')
assert.deepEqual(app.author, { '@id': organization['@id'] })
assert.deepEqual(app.publisher, app.author)
assert.equal(app.downloadUrl.length, 3)
assert.doesNotMatch(updatesPage(releases), /application\/ld\+json/)

const decode = text => text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&')
const visible = [...html.matchAll(/<details name="yogurt-faq"[^>]*>([^]*?)<\/details>/g)].map(([, card]) => ({
  question: decode(card.match(/<summary>([^<]+)/)[1]),
  answer: decode(card.match(/<p>([^]*?)<\/p>/)[1]),
}))
assert(visible.length > 0)
assert.deepEqual(questions.map(q => ({ question: q.name, answer: q.acceptedAnswer.text })), visible)
const special = 'Meetings </script> & notes'
const escaped = [...homeStructuredData(special, 'v1.0.0').matchAll(jsonLd)]
assert.equal(JSON.parse(escaped[0][1])['@graph'][0].description, special)
console.log('Homepage JSON-LD parses and matches the visible FAQ, description, publisher and release.')
