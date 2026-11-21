import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ContextTarget } from '../../../shared/askContext'
import type { LibrarySource } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { keys } from '../keys'
import { rememberScrollPositions } from '../useScrollMemory'
import { scopePrompt } from './AskContext'
import { AskConversation } from './AskConversation'
import { InlineError } from './InlineError'
import { SidebarToggle } from './Icons'
import { setToastDialog } from './TrashToast'

export function ScopedAsk({ scope, recording, toolbar, onSource }: {
  scope: ContextTarget; recording: boolean; toolbar: HTMLElement | null; onSource: (source: LibrarySource, match?: string) => void
}) {
  const scopeKey = `${scope.kind}/${scope.id}`
  const preference = `ask.expanded/${scopeKey}`
  const [expanded, setExpanded] = useState(() => {
    try { return window.localStorage.getItem(preference) === 'true' } catch { return false }
  })
  const [id, setId] = useState('')
  const [version, setVersion] = useState(0)
  const [error, setError] = useState(false)
  const creating = useRef<Promise<string>>(undefined)
  const [narrow, setNarrow] = useState(false)
  const opener = useRef<HTMLElement>(null)
  const restoring = useRef(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const change = (open: boolean) => {
    setExpanded(open)
    try { window.localStorage.setItem(preference, String(open)) } catch { /* Keep this visit usable. */ }
  }
  const focusField = () => dialog.current?.querySelector('textarea')?.focus({ preventScroll: true })
  const close = () => {
    restoring.current = true
    change(false)
  }
  const ensureConversation = () => {
    if (!creating.current) {
      setError(false)
      creating.current = window.yogurt.conversations.current([{ kind: scope.kind, id: scope.id }]).then(next => {
        setId(next)
        return next
      }).catch(cause => { creating.current = undefined; setError(true); throw cause })
    }
    return creating.current
  }
  useEffect(() => {
    let active = true
    setError(false)
    void window.yogurt.conversations.currentId([{ kind: scope.kind, id: scope.id }]).then(next => {
      if (active && !creating.current && next) setId(next)
    }).catch(() => { if (active && !creating.current) setError(true) })
    return () => { active = false }
  }, [scope.kind, scope.id, version])
  useLayoutEffect(() => {
    const workspace = dialog.current?.closest<HTMLElement>('.workspace-content')
    if (!workspace) return
    const d = dialog.current!
    const resize = () => {
      setNarrow(workspace.getBoundingClientRect().width < 820)
      if (d.dataset.expanded === 'false') workspace.style.setProperty('--scoped-ask-height', `${d.offsetHeight}px`)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(workspace)
    observer.observe(d)
    return () => { observer.disconnect(); workspace.style.removeProperty('--scoped-ask-height') }
  }, [])
  // Promote the same editor to the native dialog top layer only while the document cannot fit beside it.
  useLayoutEffect(() => {
    const d = dialog.current
    if (!d || !narrow || !expanded) return
    d.close()
    d.showModal()
    setToastDialog(d)
    focusField()
    return () => {
      setToastDialog(null)
      d.close()
      d.open = true
      if (d.isConnected) focusField()
    }
  }, [narrow, expanded])
  useLayoutEffect(() => {
    if (expanded || !restoring.current) return
    restoring.current = false
    if (opener.current?.isConnected) opener.current.focus({ preventScroll: true })
    else focusField()
  }, [expanded])
  useLayoutEffect(() => { if (version && expanded) focusField() }, [version])
  const label = scopePrompt(scope.kind)
  return <>
    {toolbar && createPortal(<button id="scoped-ask-toggle" data-testid="chat-open" className="ghost-btn workspace-icon agenda-toggle no-drag" aria-label={label}
      aria-controls="scoped-ask" aria-expanded={expanded} title={`${label} (${keys('⌘J')})`}
      onClick={event => { if (expanded) close(); else { opener.current = event.currentTarget; change(true); focusField() } }}><SidebarToggle size={16} className="flex-none -scale-x-100 rtl:scale-x-100" aria-hidden="true" /></button>, toolbar)}
    <dialog open ref={dialog} id="scoped-ask" data-testid={expanded ? 'chat-panel' : 'chat-dock'} className={expanded ? 'scoped-ask chat-panel' : 'scoped-ask'} aria-label={label} aria-labelledby={expanded ? 'meeting-chat-title' : undefined}
      data-narrow={narrow} data-expanded={expanded} aria-modal={narrow && expanded || undefined}
      onFocusCapture={event => {
        const source = event.relatedTarget
        if (source instanceof HTMLElement && source !== document.body && !event.currentTarget.contains(source)) opener.current = source
      }}
      onCancel={event => { event.preventDefault(); close() }}
      onKeyDown={event => {
        if (!expanded || event.key !== 'Escape' || event.defaultPrevented || (event.target as HTMLElement).closest('[role="menu"],[role="dialog"],[role="alertdialog"]') || dialog.current?.querySelector('.citation-card:not([data-ending-style])')) return
        event.stopPropagation(); event.preventDefault(); close()
      }}>
      {error && <InlineError testId="chat-open-error"><span>{t("Couldn't load this conversation.")}</span><button className="workspace-button" onClick={() => { void ensureConversation().catch(() => {}) }}>{t('Try again')}</button></InlineError>}
      <AskConversation key={version} id={id} pendingDraftKey={scopeKey} ensureConversation={ensureConversation} panel recording={recording} scope={scope} loadError={error}
        onSend={() => change(true)} onClose={close}
        onSelect={next => { setId(next); setVersion(v => v + 1) }}
        onExpand={id ? () => { rememberScrollPositions(); window.yogurt.nav.go(`/chat/${id}`) } : undefined}
        onDeleted={() => { close(); creating.current = undefined; setId(''); setVersion(v => v + 1) }}
        onSource={(source, match) => { close(); onSource(source, match) }} />
    </dialog>
  </>
}
