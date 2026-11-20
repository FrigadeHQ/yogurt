import assert from 'node:assert/strict'
import releases from '../content/updates.json' with { type: 'json' }
import { homePage } from './site-page.mjs'
import { updatesPage } from './updates.mjs'
import { countDownloadClicks, platforms, release } from '../public/marketing/downloads.mjs'

function checkPage(html) {
  const links = []
  for (const [selector, region] of [
    ['.site-header', html.match(/<header class="site-header"[^]*?<\/header>/)[0]],
    ['.hero', html.match(/<section[^>]+class="hero"[^]*?<\/section>/)?.[0] || ''],
    ['.site-footer', html.match(/<footer[^]*?<\/footer>/)[0]],
    ['.updates-page', html.match(/<main[^>]+class="updates-page[^]*?<\/main>/)?.[0] || ''],
  ]) {
    for (const [, href] of region.matchAll(/<a\b[^>]*?href="([^"]+\/download\/[^"]+)"[^>]*>/g))
      links.push({ href, region: selector, closest: s => s === selector, dataset: {} })
  }
  const installers = [...html.matchAll(/<a\b[^>]*?href="([^"]+\/download\/[^"]+)"[^>]*>/g)]
  assert.equal(links.length, installers.length)
  assert(links.length > 0)
  // On a mobile device each primary download becomes a menu of real installer links.
  for (const _ of html.matchAll(/<a\b[^>]*\bdata-download(?:=""|\s)/g)) {
    for (const platform of Object.values(platforms))
      links.push({ href: release + platform.file, region: '.mobile-download-list', closest: s => s === '.mobile-download-list', dataset: {} })
  }

  const calls = []
  let beforeSend
  const listeners = {}
  const doc = { referrer: '', querySelectorAll: selector => links.filter(link => selector === `a[href="${link.href}"]`),
    addEventListener(name, fn, options) { assert(options.passive); listeners[name] = fn } }
  countDownloadClicks(doc, (type, data) => {
    if (type === 'beforeSend') beforeSend = data
    else { assert.equal(type, 'event'); calls.push(data) }
  })
  const placements = { '.site-header': 'nav', '.hero': 'hero', '.site-footer': 'footer', '.mobile-download-list': 'mobile chooser', '.updates-page': 'updates' }
  for (const link of links) {
    const placement = placements[link.region]
    const platform = Object.keys(platforms).find(key => link.href === release + platforms[key].file)
    assert(platform)
    assert.deepEqual(link.dataset, { downloadPlatform: platform, downloadPlacement: placement })
    // Enter activates a native anchor with a click whose detail is zero.
    for (const detail of [0, 1]) {
      listeners.click({ target: { closest: () => link }, detail })
      assert.deepEqual(calls.at(-1), { name: 'Download', data: { platform, placement } })
    }
  }
  listeners.click({ target: { closest: () => null } })
  listeners.click({ target: { closest: () => links[0] }, defaultPrevented: true })
  assert.equal(calls.length, links.length * 2)
  listeners.auxclick({ type: 'auxclick', button: 1, target: { closest: () => links[0] } })
  listeners.auxclick({ type: 'auxclick', button: 2, target: { closest: () => links[0] } })
  assert.equal(calls.length, links.length * 2 + 1)
  const event = { type: 'event', url: 'https://yogurt.so/updates?from=test#release', payload: calls[0] }
  assert.equal(beforeSend(event).url, 'https://yogurt.so/updates')
  doc.referrer = 'https://example.org/?private=1'
  assert.equal(beforeSend(event), null)
  const pageview = { type: 'pageview', url: event.url }
  assert.equal(beforeSend(pageview), pageview)
  assert.match(html, /<meta name="referrer" content="strict-origin"/)
  countDownloadClicks(doc, () => { throw Error('blocked') })
  countDownloadClicks(doc, type => { if (type === 'event') throw Error('blocked') })
  assert.doesNotThrow(() => listeners.click({ target: { closest: () => links[0] } }))
}
checkPage(homePage())
checkPage(updatesPage(releases))
console.log('Installer anchors, mobile choices, keyboard activation, event privacy and blocked analytics passed.')
