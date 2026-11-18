import assert from 'node:assert/strict'

// Runs in the production document. Keep measuring while both the opening and closing
// cards are moving, including when an unusually long answer pushes the footer farther down.
async function measureFaq(longAnswers) {
  const frame = document.querySelector('#questions .faq-cards')
  const tab = document.querySelector('.site-footer .footer-dock')
  const cards = [...frame.querySelectorAll('details')]
  const originals = cards.map(card => card.querySelector('p').textContent)
  await document.fonts.ready
  frame.scrollIntoView({block: 'start', behavior: 'instant'})
  if (longAnswers) {
    cards.forEach((card, i) => {
      card.querySelector('p').textContent = Array(5).fill(originals[i].trim()).join(' ')
    })
  }
  const gap = () => tab.getBoundingClientRect().top - frame.getBoundingClientRect().bottom
  const readings = {}
  let frames = 0
  async function sample(state, ms) {
    const end = performance.now() + ms
    let min = gap()
    do {
      await new Promise(requestAnimationFrame)
      min = Math.min(min, gap())
      frames++
    } while (performance.now() < end)
    readings[state] = min
  }
  function toggle(i) {
    cards[i].querySelector('summary').click()
  }
  try {
    await sample('closed', 30)
    for (const [i, card] of cards.entries()) {
      toggle(i)
      await sample(card.id, 300)
      if (!card.open || cards.filter(item => item.open).length !== 1) throw Error('FAQ selection failed')
      const answer = card.querySelector('.faq-answer')
      const text = card.querySelector('p').getBoundingClientRect()
      if (!text.height || text.bottom > answer.getBoundingClientRect().bottom + 1 ||
          text.bottom > frame.getBoundingClientRect().bottom || getComputedStyle(answer).opacity !== '1') {
        throw Error('Answer did not finish expanding: ' + card.id)
      }
    }
    toggle(cards.length - 1)
    await sample('closing-last', 300)
    for (const [n, i] of [4, 5, 0, 5, 5, 2, 1, 4, 5].entries()) {
      toggle(i)
      await sample('rapid-' + n, 35)
    }
    await sample('last-settled', 300)
    return { readings, frames, theme: document.documentElement.dataset.theme, count: cards.length }
  } finally {
    cards.forEach((card, i) => {
      card.open = false
      if (longAnswers) card.querySelector('p').textContent = originals[i]
    })
  }
}

export async function verifyFaqClearance(call, origin) {
  await call('Page.bringToFront')
  for (const width of [320, 390, 768, 1280]) {
    await call('Emulation.setDeviceMetricsOverride', {width, height: 900, deviceScaleFactor: 1, mobile: width < 761})
    for (const theme of ['light', 'dark']) {
      await call('Emulation.setEmulatedMedia', {features: [
        {name: 'prefers-color-scheme', value: theme}, {name: 'prefers-reduced-motion', value: 'no-preference'},
      ]})
      for (const long of [false, true]) {
        const url = new URL('/', origin)
        url.searchParams.set('faq-check', [width, theme, long].join('-'))
        url.hash = 'questions'
        await call('Page.navigate', {url: url.href})
        const sample = await call('Runtime.evaluate', {awaitPromise: true, returnByValue: true, expression: `(async () => {
          if (document.readyState !== 'complete') await new Promise(resolve => addEventListener('load', resolve, {once:true}))
          return (${measureFaq})(${long})
        })()`})
        assert(!sample.exceptionDetails, sample.exceptionDetails?.exception?.description)
        const {readings, frames, count, theme: actualTheme} = sample.result.value
        assert.equal(count, 6)
        assert.equal(actualTheme, theme)
        assert(frames > 20, 'must observe intermediate animation frames')
        const required = (width <= 760 ? 88 : 128) + 24 // section spacing and footer clearance
        const minimum = Math.min(...Object.values(readings))
        const label = width + 'px ' + theme + (long ? ' extended' : ' published')
        for (const [state, distance] of Object.entries(readings)) {
          assert(distance >= required - 0.5, label + ' ' + state + ': ' + distance + 'px to the footer tab')
        }
        console.log('FAQ clearance', label, JSON.stringify({minimum, frames, readings}))
      }
    }
  }
}
