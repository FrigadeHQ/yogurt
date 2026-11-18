// Measure the tallest single open row at this width. Keyboard focus stays in the live list.
function reserve(list, rows, select) {
  let lastWidth = 0
  function measure(force = false) {
    const width = list.getBoundingClientRect().width
    if (!width || (!force && width === lastWidth)) return
    lastWidth = width
    const copy = list.cloneNode(true)
    copy.inert = true
    copy.setAttribute('aria-hidden', 'true')
    Object.assign(copy.style, {
      position: 'absolute',
      visibility: 'hidden',
      width: width + 'px',
      height: 'max-content',
      minHeight: '0',
    })
    copy.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'))
    copy.querySelectorAll('[name]').forEach((el) => el.removeAttribute('name'))
    list.after(copy)
    const items = [...copy.querySelectorAll(rows)]
    let height = 0
    for (const active of items) {
      for (const row of items) select(row, row === active)
      height = Math.max(height, copy.getBoundingClientRect().height)
    }
    copy.remove()
    list.style.minHeight = Math.ceil(height) + 'px'
  }
  new ResizeObserver(() => measure()).observe(list)
  document.fonts.ready.then(() => measure(true))
}
reserve(document.querySelector('.tour-list'), '.tour-item', (row, open) => {
  row.dataset.selected = String(open)
})

function revealAnswer() {
  const item = document.getElementById(location.hash.slice(1))
  if (item?.matches('.faq-cards details')) item.open = true
}
window.addEventListener('hashchange', revealAnswer)
revealAnswer()
