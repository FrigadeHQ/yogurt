import type { ClipboardEvent } from 'react'

/**
 * Copying from the transcript gives the words as they are shown. Each line carries its time for screen readers
 * (.sr-only), which the browser would otherwise copy into the middle of the text ("del modelo58:43 de negocio").
 * The selection is laid out off screen without them, so the copy keeps its line breaks between turns and bubbles.
 */
export function copyAsShown(e: ClipboardEvent<HTMLElement>): void {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return
  const range = sel.getRangeAt(0)
  if (!e.currentTarget.contains(range.commonAncestorContainer)) return
  const box = document.createElement('div')
  box.setAttribute('aria-hidden', 'true')
  box.style.cssText = 'position:fixed;left:-99999px;top:0;width:600px;white-space:normal'
  box.append(range.cloneContents())
  box.querySelectorAll('.sr-only').forEach((el) => el.remove())
  document.body.append(box)
  try {
    const text = box.innerText.replace(/\n{3,}/g, '\n\n').trim()
    e.clipboardData.setData('text/plain', text)
    e.clipboardData.setData('text/html', box.innerHTML)
    e.preventDefault()
  } finally { box.remove() }
}
