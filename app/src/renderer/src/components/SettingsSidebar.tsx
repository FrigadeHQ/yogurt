import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { language, t } from '../../../shared/i18n'
import { settingsRoute, settingsSections, type SettingsSection } from '../../../shared/routes'
import { command, keys, onMac } from '../keys'
import { sectionFor, sections } from '../settingsSections'
import { ArrowLeft, Search, X } from './Icons'

type Hit = { section: SettingsSection; label: string; words: string; target: HTMLElement }
const normalize = (text: string) => text.toLocaleLowerCase(language()).normalize('NFC').trim()
const overlay = 'dialog[open], [aria-modal="true"], [role="menu"], [role="dialog"]'

function indexSettings(screen: HTMLElement): Hit[] {
  const hits: Hit[] = []
  for (const page of screen.querySelectorAll<HTMLElement>('[data-settings-section]')) {
    const section = page.dataset.settingsSection as SettingsSection
    const labels = page.querySelectorAll<HTMLElement>('.settings-section-heading, .settings-label, .calendar-link-form label, .settings-backup-actions :is(button,a), [data-settings-item]')
    for (const target of labels) {
      if (target.closest('.loading-mask, [data-settings-skip], .settings-calendar-summary')) continue
      const label = (target.getAttribute('aria-label') || target.textContent)?.trim()
      if (label) hits.push({ section, label, words: normalize(label + ' ' + (target.dataset.settingsKeywords ?? '')), target })
    }
  }
  return hits
}

function reveal(target: HTMLElement) {
  // Calendar link fields may be nested inside two closed disclosures.
  const panels: HTMLElement[] = []
  for (let el = target.parentElement; el; el = el.parentElement) if (el.matches('.accordion[inert]')) panels.unshift(el)
  for (const panel of panels) {
    const toggle = document.querySelector<HTMLButtonElement>(`button[aria-controls="${CSS.escape(panel.id)}"][aria-expanded="false"]`)
    if (toggle) {
      flushSync(() => toggle.click())
      for (const animation of panel.getAnimations({ subtree: true })) {
        if (animation instanceof CSSTransition) animation.finish()
      }
    }
  }
  const row = target.closest<HTMLElement>('.settings-row') ?? target
  const control = target instanceof HTMLLabelElement && target.control instanceof HTMLElement ? target.control : target
  if (!control.matches('input, select, button, a[href], [tabindex]')) control.tabIndex = -1
  control.focus({ preventScroll: true })
  row.scrollIntoView({ block: 'center', behavior: 'instant' })
}

export function SettingsSidebar({ focus, go, back, onFilter }: {
  focus?: string; go(route: string): void; back(): void; onFilter(active: boolean): void
}) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState<Hit[]>([])
  const input = useRef<HTMLInputElement>(null)
  const section = sectionFor(focus)
  const term = normalize(query)
  const searching = !!term
  const clear = () => { setQuery(''); onFilter(false); input.current?.focus() }
  useEffect(() => () => onFilter(false), [onFilter])
  useLayoutEffect(() => {
    const screen = document.querySelector<HTMLElement>('.settings-screen')
    if (!searching || !screen) return
    const read = () => setIndex(indexSettings(screen))
    read()
    const observer = new MutationObserver(read)
    observer.observe(screen, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-settings-keywords', 'aria-label'] })
    return () => { observer.disconnect(); setIndex([]) }
  }, [searching])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || document.querySelector(overlay)) return
      if (e.key === 'Escape' && query) { e.preventDefault(); clear() }
      else if (command(e) && e.code === 'KeyF' && !e.shiftKey && !e.altKey && !(onMac() && e.ctrlKey)) {
        e.preventDefault(); input.current?.focus(); input.current?.select()
      }
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [query, onFilter])
  const groups = settingsSections.map(id => ({
    id, items: searching ? index.filter(hit => hit.section === id && hit.words.includes(term)) : [],
  })).filter(({ id, items }) => !searching || items.length || normalize(sections[id].label()).includes(term))
  const pick = (hit: Hit) => {
    flushSync(() => go(settingsRoute(hit.section)))
    if (hit.target.isConnected) reveal(hit.target)
  }
  return <nav className="workspace-sidebar-body settings-nav" aria-label={t('Settings')}>
    <button className="workspace-nav settings-back" data-testid="settings-back" onClick={back}><ArrowLeft size={16} className="rtl:-scale-x-100" aria-hidden="true" />{t('Back to app')}</button>
    <div className="workspace-search settings-filter">
      <Search size={15} aria-hidden="true" />
      <input ref={input} type="text" data-testid="settings-filter" aria-label={t('Search settings')} aria-controls="settings-nav-results" aria-keyshortcuts={onMac() ? 'Meta+F' : 'Control+F'} placeholder={t('Search…')} title={keys('⌘F')}
        autoComplete="off" spellCheck={false} value={query} onChange={e => { setQuery(e.target.value); onFilter(!!e.target.value.trim()) }}
        onKeyDown={e => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing || !groups.length || !searching) return
          e.preventDefault()
          const first = groups[0]
          if (first.items.length && normalize(sections[first.id].label()) !== term) pick(first.items[0])
          else go(settingsRoute(first.id))
        }} />
      {query && <button className="ghost-btn settings-filter-clear" aria-label={t('Clear')} onClick={clear}><X size={13} aria-hidden="true" /></button>}
    </div>
    <div id="settings-nav-results" className="settings-nav-list">
      <h1 data-testid="settings-heading" className={searching ? 'sr-only' : undefined}>{t('Settings')}</h1>
      {groups.map(({ id, items }) => {
        const { icon: Icon, label } = sections[id]
        return <Fragment key={id}>
          <button className="workspace-nav" data-testid={`settings-nav-${id}`} aria-current={id === section ? 'page' : undefined} onClick={() => go(settingsRoute(id))}>
            <Icon size={16} aria-hidden="true" />{label()}
          </button>
          {items.map((item, i) => <button className="settings-nav-result" key={item.label + i} onClick={() => pick(item)}>{item.label}</button>)}
        </Fragment>
      })}
      {groups.length === 0 && <p className="settings-nav-empty" role="status">{t('No settings match')}</p>}
    </div>
  </nav>
}
