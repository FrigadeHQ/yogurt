import assert from 'node:assert/strict'

// Runs inside Chrome against the rendered walkthrough. Capture the synchronous
// selection frame as well as each painted frame, including interrupted transitions.
export async function sampleWalkthrough(mode) {
  const rows = [...document.querySelectorAll('.tour-item')]
  const buttons = rows.map((row) => row.querySelector('button'))
  const result = {
    frames: 0,
    collisions: 0,
    worst: 0,
    closingVisible: 0,
    aboveTitle: 0,
    changes: [],
    settled: false,
  }
  let active = -1
  const start = performance.now()
  let lastChange = start
  function capture() {
    result.frames++
    const current = rows.findIndex((row) => row.dataset.selected === 'true')
    if (active !== current) {
      active = current
      result.changes.push(current)
      lastChange = performance.now()
    }
    const headings = buttons.map((button) =>
      button.querySelector('span:nth-child(2)').getBoundingClientRect()
    )
    for (const [i, row] of rows.entries()) {
      const description = row.querySelector('.tour-description')
      const rect = description.getBoundingClientRect(),
        style = getComputedStyle(description)
      if (!rect.height || style.visibility !== 'visible' || Number(style.opacity) === 0) continue
      if (i !== active) result.closingVisible++
      if (rect.top < headings[i].bottom - 0.01) result.aboveTitle++
      for (const title of headings) {
        if (rect.left >= title.right || rect.right <= title.left) continue
        const overlap = Math.min(rect.bottom, title.bottom) - Math.max(rect.top, title.top)
        if (overlap > 0.01) {
          result.collisions++
          result.worst = Math.max(result.worst, overlap)
        }
      }
    }
  }
  async function sampleFor(ms) {
    const end = performance.now() + ms
    do {
      capture()
      await new Promise(requestAnimationFrame)
    } while (performance.now() < end)
    capture()
  }
  capture()
  if (mode === 'auto') {
    while (performance.now() - start < 90000) {
      await new Promise(requestAnimationFrame)
      capture()
      if (result.changes.length >= 4 && performance.now() - lastChange >= 310) break
    }
  } else {
    // Select every ordered pair so each title moves both up and down.
    const selections = mode === 'rapid' ? [1, 1, 0, 2, 1, 2, 0] : [1, 0, 2, 1, 2, 0]
    for (const index of selections) {
      buttons[index].click()
      capture()
      await sampleFor(mode === 'rapid' ? 45 : 310)
    }
  }
  await sampleFor(310)
  const index = buttons.findIndex((button) => button.getAttribute('aria-expanded') === 'true')
  const open = rows[index].querySelector('.tour-description')
  result.settled =
    getComputedStyle(open).visibility === 'visible' &&
    Number(getComputedStyle(open).opacity) === 1 &&
    open.clientHeight >= open.scrollHeight
  return result
}

export async function verifyWalkthroughFrames(call, origin) {
  await call('Page.bringToFront')
  // Verify the live CSS and title positions before exporting static renderer images.
  for (const width of [1280, 390]) {
    await call('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width < 761,
    })
    await call('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    })
    await call('Page.navigate', { url: origin + '/?walkthroughViewport=' + width + '#how-it-works' })
    const sampled = await call('Runtime.evaluate', {
      expression: `(async () => {
        if (document.readyState !== 'complete') await new Promise(resolve => addEventListener('load', resolve, {once:true}))
        await document.fonts.ready
        document.querySelector('.tour-visual').scrollIntoView({block:'center', behavior:'instant'})
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        return [await (${sampleWalkthrough})('auto'), await (${sampleWalkthrough})('manual'), await (${sampleWalkthrough})('rapid')]
      })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    assert(!sampled.exceptionDetails, sampled.exceptionDetails?.exception?.description)
    for (const [i, trace] of sampled.result.value.entries()) {
      assert.deepEqual(
        trace.changes,
        i === 0 ? [0, 1, 2, 0] : [0, 1, 0, 2, 1, 2, 0],
        'every step must open and close'
      )
      assert(
        trace.frames > 10 && trace.settled,
        'the walkthrough must render intermediate frames and settle'
      )
      assert.equal(
        trace.collisions + trace.aboveTitle,
        0,
        'visible walkthrough text must stay below its title and clear every other title'
      )
      assert.equal(
        trace.closingVisible,
        0,
        'a closing description must disappear before its row contracts'
      )
    }
  }
}
