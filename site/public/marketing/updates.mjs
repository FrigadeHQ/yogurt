const archive = document.getElementById('earlier')
const batches = [...archive?.querySelectorAll('.release-batch') || []]
const end = document.querySelector('.archive-end')
const status = document.querySelector('.archive-status')
let shown = batches.length
let observer

function revealThrough(index, announce = false) {
  if (index < shown) return
  const added = batches.slice(shown, index + 1)
  for (const batch of added) batch.removeAttribute('hidden')
  shown += added.length
  if (announce) {
    const count = added.reduce((n, batch) => n + batch.querySelectorAll('.release-card').length, 0)
    const last = added[added.length - 1].querySelectorAll('.release-card')
    status.textContent = count + (count === 1 ? ' more release loaded.' : ' more releases loaded.') +
      (shown === batches.length ? ' All releases are visible.' : ' Showing through ' + last[last.length - 1].id + '.')
  }
  observer.disconnect()
  if (shown < batches.length) observer.observe(end)
}

if (end && batches.length > 1 && 'IntersectionObserver' in window &&
    'onbeforematch' in document.documentElement && new URLSearchParams(location.search).get('all') !== '1') {
  shown = 1
  for (const batch of batches.slice(1)) batch.setAttribute('hidden', 'until-found')
  end.classList.add('auto-load')
  observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting) && shown < batches.length) revealThrough(shown, true)
  }, {rootMargin:'0px 0px 320px'})
  observer.observe(end)

  // Reveal in document order, including when Find, keyboard or assistive navigation reaches the edge.
  archive.addEventListener('beforematch', event => {
    revealThrough(batches.indexOf(event.target.closest('.release-batch')))
  })
  archive.addEventListener('focusin', event => {
    if (shown === batches.length) return
    const visibleCards = batches[shown - 1].querySelectorAll('.release-card')
    if (event.target.closest('.release-card') === visibleCards[visibleCards.length - 1]) revealThrough(shown, true)
  })
}

function revealFragment() {
  const target = document.getElementById(location.hash.slice(1))
  if (!target) return
  // An explicit jump to the footer must land below the complete history.
  revealThrough(target.id === 'footer' ? batches.length - 1 : batches.indexOf(target.closest('.release-batch')))
  const details = target.closest('details')
  if (details) {
    details.dataset.instant = ''
    for (let el = details; el; el = el.parentElement) {
      if (el.tagName === 'DETAILS') el.open = true
    }
  }
  target.scrollIntoView({behavior:'instant', block:'start'})
  if (details) delete details.dataset.instant
}
revealFragment()
window.addEventListener('hashchange', revealFragment)
document.addEventListener('click', event => {
  const link = event.target.closest('a[href^="#"]')
  if (link && link.hash === location.hash) revealFragment()
})
