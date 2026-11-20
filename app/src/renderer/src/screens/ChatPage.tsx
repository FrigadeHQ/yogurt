import { InlineError } from '../components/InlineError'
import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Popover } from '@base-ui/react/popover'
import { ArrowLeft, Clock } from 'lucide-react'
import type { ConversationSummary, ConversationView, LibrarySource } from '../../../shared/types'
import { askHomeConversation, recentHistory } from '../../../shared/askPresentation'
import { t, language } from '../../../shared/i18n'
import { useDay } from '../dates'
import { AskConversation } from '../components/AskConversation'
import { ConversationActions, ConversationDialog } from '../components/ConversationActions'
import { StartRecording } from '../components/StartRecording'
import { Loading } from '../components/Loading'
import { LoadingContent } from '../components/LoadingContent'
import { ScrollFade } from '../components/ScrollFade'

export function ChatPage({ id, go, openSource }: { id: string | null; go: (route: string) => void; openSource: (s: LibrarySource, match?: string) => void }) {
  const [list, setList] = useState<ConversationSummary[]>()
  const [current, setCurrent] = useState<string>()
  const [prepared, setPrepared] = useState<ConversationView>()
  const [homeFailed, setHomeFailed] = useState(false)
  const [listFailed, setListFailed] = useState(false)
  const [listAttempt, setListAttempt] = useState(0)
  const [failedTarget, setFailedTarget] = useState<{ id: string | null }>()
  const [recent, setRecent] = useState(false)
  const recentButton = useRef<HTMLButtonElement>(null)
  const [editing, setEditing] = useState<{ id: string; title: string; kind: 'rename' | 'delete' }>()
  const [showAll, setShowAll] = useState(false)
  const [revision, setRevision] = useState(0)
  const page = useRef<HTMLDivElement & { startViewTransition?: (update: () => void) => ViewTransition }>(null)
  const transition = useRef<ViewTransition | null>(null)
  const navigation = useRef(0)
  const change = (update: () => void) => {
    transition.current?.skipTransition()
    if (!page.current?.startViewTransition) { update(); return }
    transition.current = page.current.startViewTransition(() => flushSync(update))
    void transition.current.ready.catch(() => {})
  }
  useEffect(() => () => { navigation.current++; transition.current?.skipTransition() }, [])
  useDay()
  useEffect(() => {
    let active = true
    setListFailed(false)
    const off = window.yogurt.conversations.onList(list => { setList(list); setListFailed(false) })
    void window.yogurt.conversations.list().then(l => { if (active) setList(cur => cur ?? l) }).catch(() => { if (active) setListFailed(true) })
    return () => { active = false; off() }
  }, [listAttempt])
  useEffect(() => {
    if (id) return
    let active = true
    setHomeFailed(false)
    void askHomeConversation(window.yogurt.conversations).then(cid => { if (active) setCurrent(cid) }).catch(() => { if (active) setHomeFailed(true) })
    return () => { active = false }
  }, [id, revision])
  const selected = id ?? current
  const history = recentHistory(list ?? [], showAll ? Infinity : 30)
  const navigate = async (cid: string | null) => {
    setFailedTarget(undefined)
    const request = ++navigation.current
    setRecent(false)
    // Capture the destination with its content, rather than fading into a loading skeleton.
    const target = cid ?? await askHomeConversation(window.yogurt.conversations)
    const view = await window.yogurt.conversations.get(target)
    if (request !== navigation.current) return
    if (!view) throw new Error('Conversation not found')
    change(() => { setPrepared(view); setCurrent(target); go(cid ? `/chat/${cid}` : '/chat') })
  }
  const open = (cid: string | null) => {
    const read = navigate(cid), request = navigation.current
    void read.catch(() => { if (request === navigation.current) setFailedTarget({ id: cid }) })
  }
  const back = () => open(null)
  const deleted = (cid: string) => {
    if (cid === selected) { setCurrent(undefined); setRevision(n => n + 1); setRecent(false); go('/chat') }
  }
  const relative = (ms: number) => {
    const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60_000))
    const unit = minutes < 60 ? 'minute' : minutes < 1440 ? 'hour' : 'day'
    return new Intl.RelativeTimeFormat(language(), { numeric: 'auto' }).format(-Math.floor(minutes / (unit === 'minute' ? 1 : unit === 'hour' ? 60 : 1440)), unit)
  }
  return <div ref={page} data-testid="chat-page" className={`chat-page ask-page${id ? ' ask-full-thread' : ' ask-home'}`}>
    {!id && <StartRecording />}
    <div className="ask-page-toolbar">
      {id && <button className="ghost-btn ask-back" onClick={back}><ArrowLeft size={14} aria-hidden="true" />{t('Ask')}</button>}
      <Popover.Root open={recent} onOpenChange={next => { setRecent(next); if (!next) setShowAll(false) }}>
        <Popover.Trigger ref={recentButton} data-testid="chat-recent" className="ghost-btn"><Clock size={14} aria-hidden="true" />{t('Recent')}</Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={16} className="ask-recent-positioner">
            <Popover.Popup data-testid="chat-recent-list" className="menu-entry ask-history" aria-label={t('Conversations')}>
              <ScrollFade><div className="ask-history-scroll">
              {listFailed && <InlineError testId="chat-history-error"><span>{t("Couldn't load your conversations.")}</span>
                <button className="workspace-button" onClick={() => setListAttempt(n => n + 1)}>{t('Try again')}</button>
              </InlineError>}
              <LoadingContent pending={!list && !listFailed} skeleton={<Loading layout="history" />}>
              {list && !history.groups.some(g => g.length) && <p className="ask-history-empty">{t('Your conversations will show up here.')}</p>}
              {[t('Today'), t('This week'), t('Earlier')].map((label, group) => !!history.groups[group].length && <section key={group}>
                <h2>{label}</h2><ul>{history.groups[group].map(c => <li key={c.id} className="ask-history-row row-swap" onContextMenu={e => {
                  e.preventDefault(); e.currentTarget.querySelector<HTMLButtonElement>('[data-testid="chat-menu"]')?.click()
                }}>
                  <button data-testid="chat-history-item" className="ask-history-link" onClick={() => open(c.id)} title={c.title || c.draft}>
                    <strong>{c.title || c.draft || t('New chat')}</strong><time className="row-swap-meta" dateTime={new Date(c.updatedAt).toISOString()}>{relative(c.updatedAt)}</time>
                  </button>
                  <ConversationActions className="row-swap-actions" id={c.id} title={c.title} onDeleted={() => deleted(c.id)} onEdit={kind => { setRecent(false); setEditing({ id: c.id, title: c.title, kind }) }} />
                </li>)}</ul>
              </section>)}
              {history.hasMore && <button data-testid="chat-history-all" className="ghost-btn ask-history-all" onClick={() => setShowAll(true)}>{t('Show all')}</button>}
              </LoadingContent></div></ScrollFade>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
    {editing && <ConversationDialog {...editing} onClose={() => { setEditing(undefined); recentButton.current?.focus({ preventScroll: true }) }} onDeleted={() => deleted(editing.id)} />}
    {(failedTarget || (!id && homeFailed)) && <InlineError testId="chat-page-load-error"><span>{t("Couldn't load this conversation.")}</span>
      <button className="workspace-button" onClick={() => failedTarget ? open(failedTarget.id) : setRevision(n => n + 1)}>{t('Try again')}</button>
    </InlineError>}
    <AskConversation key={selected ?? "home"} id={selected ?? ""} initial={prepared?.id === selected ? prepared : undefined} loadError={!id && homeFailed} home={!id} onSelect={open} onDeleted={() => { if (selected) deleted(selected) }} onSource={openSource} />
  </div>
}
