import { expect, type Locator } from '@playwright/test'

export function expectBesideAsk(toast: Locator) {
  return expect.poll(() => toast.evaluate(el => {
    const panel = document.querySelector('.chat-panel[open]')
    if (!panel) return null
    const chat = panel.getBoundingClientRect(), notice = el.getBoundingClientRect()
    const gap = getComputedStyle(panel).direction === 'rtl' ? notice.left - chat.right : chat.left - notice.right
    return [Math.round(gap), Math.round(chat.bottom - notice.bottom)]
  })).toEqual([12, 0])
}
