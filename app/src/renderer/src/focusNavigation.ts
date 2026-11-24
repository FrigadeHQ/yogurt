// A portal or native dialog has its own navigation history, even when it lives under document.body.
const surfaceSelector = [
  'dialog', '[role="dialog"]', '[role="alertdialog"]', '[role="menu"]', '[role="toolbar"]',
  '.menu-entry', '.ask-picker', '.citation-card', '.app-toast-viewport', '.transcript-find-clip',
  '.calendar-link-form', '.note-date-picker', '.meeting-selection-bar', '.settings-screen', '.chat-page',
  '.document-main', '.native-home', '.native-folder',
].join(',')

// The only element carrying the marker is the actual focus target.
export const visibleFocus = ':focus-visible:not([data-quiet-focus]),[data-focus-ring]'

export function installFocusNavigation(doc: Document) {
  const page = doc.documentElement
  const contrast = doc.defaultView?.matchMedia('(forced-colors: active), (prefers-contrast: more)')
  const stack = [{ surface: page, keyboard: false }]
  let marked: Element | null = null
  let keyboardActivation = false
  let navigating = false
  let reset: ReturnType<typeof setTimeout> | undefined

  function frame(el: Element, activated = false): { surface: HTMLElement; keyboard: boolean } {
    const surface = el.closest<HTMLElement>(surfaceSelector) ?? page
    const index = stack.findIndex(entry => entry.surface === surface)
    if (index >= 0) stack.length = index + 1
    else {
      while (stack.length > 1 && !stack[stack.length - 1].surface.isConnected) stack.pop()
      // A shortcut can enter a child before its containing screen has ever received focus.
      const parent = surface.parentElement?.closest<HTMLElement>(surfaceSelector)
      if (parent && !stack.some(entry => entry.surface === parent)) frame(parent)
      stack.push({ surface, keyboard: activated || stack[stack.length - 1].keyboard })
    }
    return stack[stack.length - 1]
  }

  function mark(el: Element | null, keyboard: boolean) {
    marked?.removeAttribute('data-quiet-focus')
    marked?.removeAttribute('data-focus-ring')
    marked = el
    if (!el || el === doc.body || el === page) return
    if (keyboard || (contrast?.matches && el.matches(':focus-visible'))) el.setAttribute('data-focus-ring', '')
    else if (!contrast?.matches) el.setAttribute('data-quiet-focus', '')
  }
  function focus(event: FocusEvent) {
    if (!(event.target instanceof Element)) return
    if (event.target === page || event.target === doc.body || event.target.hasAttribute('data-base-ui-focus-guard')) return
    const entry = frame(event.target, keyboardActivation)
    keyboardActivation = false
    if (navigating) entry.keyboard = true
    mark(event.target, entry.keyboard)
  }
  function blur(event: FocusEvent) {
    if (event.target === marked) mark(null, false)
  }
  function pointer(event: PointerEvent) {
    if (!(event.target instanceof Element)) return
    navigating = false
    keyboardActivation = false
    // Portal backdrops dismiss the dialog but do not belong to the page underneath.
    if (event.target.matches('.search-backdrop,.app-modal-backdrop')) return
    frame(event.target).keyboard = false
    if (event.target.closest(surfaceSelector) === doc.activeElement?.closest(surfaceSelector)) mark(doc.activeElement, false)
  }
  function activate(event: MouseEvent) {
    // A keyboard or assistive-technology press can enter a new menu without repainting its opener.
    keyboardActivation = event.isTrusted && event.detail === 0
  }
  function key(event: KeyboardEvent) {
    navigating = false
    keyboardActivation = false
    if (event.isComposing || !(event.target instanceof Element)) return
    const jump = event.key === 'F6' || (event.key === 'F10' && (event.altKey || event.shiftKey)) || event.key === 'ContextMenu'
    if (event.metaKey || event.ctrlKey || (event.altKey && !jump)) return
    const travel = /^(Arrow(Up|Down|Left|Right)|Home|End)$/.test(event.key)
    if (!jump && event.key !== 'Tab' && !travel) return
    if (travel && event.target.closest('input,textarea,[contenteditable=true]')) {
      const listKey = (event.key === 'ArrowDown' || event.key === 'ArrowUp') && event.target.matches('[role=combobox],[aria-activedescendant]')
      if (!listKey && !event.target.matches('[type=range],[type=radio]')) return
    }
    // Tab can cross a surface boundary. F6 and F10 jump into another surface without changing the opener.
    navigating = true
    keyboardActivation = jump
    clearTimeout(reset)
    reset = setTimeout(() => { navigating = false }, 0)
    if (!jump) {
      frame(event.target).keyboard = true
      mark(doc.activeElement, true)
    }
  }
  function contrastChanged() {
    if (doc.activeElement) mark(doc.activeElement, frame(doc.activeElement).keyboard)
  }
  contrast?.addEventListener('change', contrastChanged)
  doc.addEventListener('focus', focus, true)
  doc.addEventListener('blur', blur, true)
  doc.addEventListener('pointerdown', pointer, true)
  doc.addEventListener('keydown', key, true)
  doc.addEventListener('click', activate, true)
  return () => {
    contrast?.removeEventListener('change', contrastChanged)
    doc.removeEventListener('focus', focus, true)
    doc.removeEventListener('blur', blur, true)
    doc.removeEventListener('pointerdown', pointer, true)
    doc.removeEventListener('keydown', key, true)
    doc.removeEventListener('click', activate, true)
    clearTimeout(reset)
    mark(null, false)
  }
}
