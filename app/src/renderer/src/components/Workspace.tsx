import { WorkspaceFolders } from '../folders'
import { AudioUploadHost } from './AudioUpload'
import { toasts } from './TrashToast'
import { askDestination, askOverDialogs } from '../../../shared/askContext'
import { Tooltip } from '@base-ui/react/tooltip'
import { ActionTooltipPopup } from './ActionTooltipPopup'
import { useSidebarPeek } from '../useSidebarPeek'
import * as Sidebar from '@animate-ui/react/primitives/sidebar'
import { useEffect, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, MeetingFile, AskBubble, Search, SidebarToggle } from './Icons'
import type { MeetingView, Folder, WidgetView } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { command, keys, onMac } from '../keys'
import { LevelBars } from './LevelBars'
import { RecordingTime } from './RecordingTime'
import { FoldersNav } from './FoldersNav'
import { FinishSetup } from './FinishSetup'
import { NotesSetup } from './NotesSetup'
import { CornerMenu } from './CornerMenu'

export function Workspace({ route, meeting, folders, go, back, forward, search, shortcuts, dismissDialogs, collapsed, sidebarMotion, toggleSidebar, children }: {
  meeting?: Pick<MeetingView, 'id' | 'title'>
  folders?: Folder[]
  route: string; go: (route: string) => void; back?: () => void; forward?: () => void; search: () => void; shortcuts: () => void; children: ReactNode
  /** closes Search and Keyboard shortcuts */
  dismissDialogs: () => void
  collapsed: boolean; sidebarMotion: boolean; toggleSidebar: (animate?: boolean) => void
}) {
  const [recording, setRecording] = useState<WidgetView | null>(null)
  useEffect(() => {
    let active = true, updated = false
    const off = window.yogurt.widget.onState((view) => { updated = true; setRecording(view) })
    void window.yogurt.widget.state().then((view) => { if (active && !updated) setRecording(view) })
    return () => { active = false; off() }
  }, [])
  const peek = useSidebarPeek(collapsed, route)
  const sidebarVisible = !collapsed || peek.open
  const sidebarLabel = collapsed ? t('Show sidebar') : t('Hide sidebar')
  const navigate = (next: string) => { if (peek.open) peek.dismiss(); go(next) }
  const sidebarTransition = { duration: sidebarMotion ? 0.2 : 0, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] }
  const note = route.startsWith('/note/')
  // a saved chat (/chat/<id>) is still under Chat
  const section = route.startsWith('/settings/') ? '/settings' : route.startsWith('/chat/') ? '/chat' : route
  const returnToRecording = recording?.kind === 'recording' && route !== `/note/${recording.meetingId}`
  useEffect(() => {
    const dialogs = () => askOverDialogs([...document.querySelectorAll<HTMLElement>('[aria-modal="true"], [role="alertdialog"]')].map(d => d.dataset.testid))
    let waiting = 0
    const ask = (tries = 0) => {
      const over = dialogs()
      if (over === 'blocked') return
      // Keyboard shortcuts closes first; Ask opens once it's gone, so its focus return can't undo it.
      if (over === 'dismiss') {
        if (!tries) dismissDialogs()
        if (tries < 30) waiting = requestAnimationFrame(() => ask(tries + 1))
        return
      }
      const target = askDestination(route)
      if (target.kind === 'focus') document.getElementById('library-question')?.focus({ preventScroll: true })
      else if (target.kind === 'panel') document.getElementById('meeting-ask')?.click()
      else void window.yogurt.conversations.current(target.chips).then(id => go(`/chat/${id}`)).catch(error => {
        console.error('Opening Ask failed', error)
        toasts.add({ title: t("Yogurt couldn't make that change. Try again.") })
      })
    }
    const key = (e: KeyboardEvent) => {
      if (!command(e) || (onMac() && e.ctrlKey) || e.altKey || e.shiftKey || e.code !== 'KeyJ' || e.defaultPrevented) return
      e.preventDefault()
      if (!e.repeat && !e.isComposing) ask()
    }
    const fromMenu = () => { void window.yogurt.nav.takeAsk().then(pending => { if (pending) ask() }) }
    const off = window.yogurt.nav.onAsk(fromMenu)
    fromMenu()
    window.addEventListener('keydown', key)
    return () => { off(); cancelAnimationFrame(waiting); window.removeEventListener('keydown', key) }
  }, [route, go, dismissDialogs])
  const links = [
    { route: '', label: t('Meetings'), Icon: MeetingFile },
    { route: '/chat', label: t('Ask'), Icon: AskBubble },
  ]
  const folder = route.startsWith('/folder/') ? folders?.find((s) => route === `/folder/${s.id}`) : undefined
  const current = links.find((link) => link.route === section) ?? (route.startsWith('/folder/') ? { label: folder?.name ?? t('Folder') } : undefined)
  const label = note ? (meeting && route === `/note/${meeting.id}` ? meeting.title : t('Meeting')) : route.startsWith('/settings') ? t('Settings') : route === '/trash' ? t('Trash') : current?.label ?? t('Meetings')
  const nav = (link: typeof links[number]) => <button key={link.route} data-testid={link.route === '' ? 'nav-home' : 'nav-chat'}
    data-sidebar="menu-button" aria-label={link.label} className="workspace-nav" aria-current={section === link.route || link.route === '' && route === '/meetings' ? 'page' : undefined} onClick={() => navigate(link.route)}>
    <link.Icon size={16} aria-hidden="true" /><span>{link.label}</span>
  </button>

  return <div className={`workspace ${collapsed ? 'sidebar-collapsed' : ''}`} data-testid="workspace" {...peek.buttonPathHandlers} data-sidebar-motion={sidebarMotion} data-peeking={peek.open} data-peek-motion={peek.pointerMotion}>
    <div className="workspace-window-bar" onPointerEnter={peek.cancel} onPointerLeave={peek.leave}>
      <div className="workspace-drag-region drag" data-testid="titlebar" aria-hidden="true" />
      <Tooltip.Root>
        <Tooltip.Trigger ref={peek.toggle} {...peek.buttonHandlers} className="ghost-btn workspace-icon workspace-sidebar-toggle no-drag" data-testid={collapsed ? 'sidebar-expand' : 'sidebar-collapse'}
          onClick={e => { peek.cancel(); toggleSidebar(e.detail > 0) }}
          onKeyDown={e => { if (collapsed && e.key === 'ArrowDown') { e.preventDefault(); peek.keyboard() } }}
          aria-expanded={sidebarVisible} aria-controls="workspace-sidebar" aria-keyshortcuts={onMac() ? 'Control+Meta+S' : 'Control+Shift+S'}
          aria-label={sidebarLabel} delay={1000}>
          <SidebarToggle className="flex-none sidebar-toggle-glyph rtl:-scale-x-100" size={16} aria-hidden="true" />
        </Tooltip.Trigger>
        <ActionTooltipPopup label={`${sidebarLabel} (${keys('⌃⌘S')})`} />
      </Tooltip.Root>
    </div>
    <Sidebar.Gap className="workspace-sidebar-gap" transition={sidebarTransition} />
    <div ref={peek.panel} id="workspace-sidebar" className="workspace-sidebar" role="complementary" aria-label={t('Main navigation')}
      inert={!sidebarVisible} aria-hidden={!sidebarVisible} onPointerEnter={peek.cancel} onPointerLeave={peek.leave}>
      <div className="workspace-sidebar-inner">
      <div className="workspace-sidebar-body">
        <button className="workspace-search no-drag" data-testid="search-open" aria-label={t('Search')} title={`${t('Search')} (${keys('⌘K')})`} onClick={search}><Search className="flex-none" size={16} aria-hidden="true" /><span>{t('Search')}</span><kbd>{keys('⌘K')}</kbd></button>
        <nav aria-label={t('Workspace')}>{links.map(nav)}</nav>
        <FoldersNav folders={folders} route={route} go={navigate} />
      </div>
      <div className="workspace-sidebar-footer">
        <FinishSetup />
        <CornerMenu visible={sidebarVisible} section={section} recording={recording?.kind === 'recording'} go={navigate} shortcuts={shortcuts} />
      </div>
      </div>
    </div>
    <div className="workspace-content" {...peek.edgeHandlers}>
      <header className="workspace-toolbar" data-note={note} data-recording-return={returnToRecording}>
        <div className="workspace-breadcrumb drag">
          <span className="workspace-history">
            <button data-testid="nav-back" className="ghost-btn workspace-icon no-drag" disabled={!back && !note} onClick={back ?? (() => go(''))} aria-label={t('Back')} title={`${t('Back')} (${keys('⌘[')})`}><ChevronLeft size={14} className="rtl:-scale-x-100" aria-hidden="true" /></button>
            <button data-testid="nav-forward" className="ghost-btn workspace-icon no-drag" disabled={!forward} onClick={forward} aria-label={t('Forward')} title={`${t('Forward')} (${keys('⌘]')})`}><ChevronRight size={14} className="rtl:-scale-x-100" aria-hidden="true" /></button>
          </span>
          <span data-testid="workspace-heading" aria-current="page" title={label}>{label}</span>
        </div>
      <NotesSetup go={go} />
      {returnToRecording && <button className="workspace-recording-link no-drag" data-testid="recording-return" data-paused={recording.paused}
        aria-label={t('Open {title}', { title: recording.title })} title={t('Open {title}', { title: recording.title })} onClick={() => go(`/note/${recording.meetingId}`)}>
        <LevelBars testId="recording-return-wave" height={16} paused={recording.paused} />
        <RecordingTime view={recording} testId="recording-return-time" className="recording-return-time" />
      </button>}
      <div id="workspace-actions" className="workspace-toolbar-actions" />
      <div id="workspace-agenda-actions" className="workspace-toolbar-actions" />
      </header>
      <WorkspaceFolders value={folders}>{children}</WorkspaceFolders>
      <AudioUploadHost />

    </div>
  </div>
}
