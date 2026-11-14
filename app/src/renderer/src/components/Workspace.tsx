import { toasts } from './TrashToast'
import { askDestination } from '../../../shared/askContext'
import * as Sidebar from '@animate-ui/react/primitives/sidebar'
import { useEffect, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react'
import type { MeetingView, Folder, WidgetView } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { command, keys, onMac } from '../keys'
import { Wordmark } from './Logo'
import { LevelBars } from './LevelBars'
import { RecordingTime } from './RecordingTime'
import { FileText, MessageCircle, Search, Settings, SidebarToggle } from './Icons'
import { FoldersNav } from './FoldersNav'
import { FinishSetup } from './FinishSetup'
import { NotesSetup } from './NotesSetup'
import { motion } from '../motion'

export function Workspace({ route, meeting, folders, go, back, forward, search, collapsed, sidebarMotion, toggleSidebar, children }: {
  meeting?: Pick<MeetingView, 'id' | 'title'>
  folders?: Folder[]
  route: string; go: (route: string) => void; back?: () => void; forward?: () => void; search: () => void; children: ReactNode
  collapsed: boolean; sidebarMotion: boolean; toggleSidebar: (animate?: boolean) => void
}) {
  const [recording, setRecording] = useState<WidgetView | null>(null)
  useEffect(() => {
    let active = true, updated = false
    const off = window.yogurt.widget.onState((view) => { updated = true; setRecording(view) })
    void window.yogurt.widget.state().then((view) => { if (active && !updated) setRecording(view) })
    return () => { active = false; off() }
  }, [])
  const sidebarTransition = { duration: sidebarMotion ? motion.surface / 1000 : 0, ease: motion.out }
  const note = route.startsWith('/note/')
  // a saved chat (/chat/<id>) is still under Chat
  const section = route.startsWith('/settings/') ? '/settings' : route.startsWith('/chat/') ? '/chat' : route
  const returnToRecording = recording?.kind === 'recording' && route !== `/note/${recording.meetingId}`
  useEffect(() => {
    const ask = () => {
      if (document.querySelector('[aria-modal="true"]:not([data-testid="chat-panel"]), [role="alertdialog"]')) return
      const target = askDestination(route)
      if (target.panel) document.getElementById('meeting-ask')?.click()
      else void window.yogurt.conversations.current(target.chips, target.fresh).then(id => go(`/chat/${id}`)).catch(error => {
        console.error('Opening Ask failed', error)
        toasts.add({ title: t("Yogurt couldn't make that change. Try again.") })
      })
    }
    const key = (e: KeyboardEvent) => {
      if (!command(e) || (onMac() && e.ctrlKey) || e.altKey || e.shiftKey || e.code !== 'KeyJ' || e.defaultPrevented) return
      e.preventDefault()
      ask()
    }
    const fromMenu = () => { void window.yogurt.nav.takeAsk().then(pending => { if (pending) ask() }) }
    const off = window.yogurt.nav.onAsk(fromMenu)
    fromMenu()
    window.addEventListener('keydown', key)
    return () => { off(); window.removeEventListener('keydown', key) }
  }, [route, go])
  const links = [
    { route: '', label: t('Meetings'), Icon: FileText },
    { route: '/chat', label: t('Ask'), Icon: MessageCircle },
    { route: '/trash', label: t('Trash'), Icon: Trash2 },
    { route: '/settings', label: t('Settings'), Icon: Settings },
  ]
  const folder = route.startsWith('/folder/') ? folders?.find((s) => route === `/folder/${s.id}`) : undefined
  const current = links.find((link) => link.route === section) ?? (route.startsWith('/folder/') ? { label: folder?.name ?? t('Folder') } : undefined)
  const label = note ? (meeting && route === `/note/${meeting.id}` ? meeting.title : t('Meeting')) : route.startsWith('/settings') ? t('Settings') : current?.label ?? t('Meetings')
  const nav = (link: typeof links[number]) => <button key={link.route} data-testid={link.route === '' ? 'nav-home' : link.route === '/chat' ? 'nav-chat' : link.route === '/settings' ? 'settings-open' : 'nav-trash'}
    data-sidebar="menu-button" aria-label={link.label} title={collapsed ? link.label : undefined} className={`workspace-nav${link.route === '/trash' ? ' workspace-trash' : ''}`} aria-current={section === link.route || link.route === '' && route === '/meetings' ? 'page' : undefined} onClick={() => go(link.route)}>
    <link.Icon size={16} strokeWidth={1.75} aria-hidden="true" /><span>{link.label}</span>
  </button>

  return <div className={`workspace ${collapsed ? 'sidebar-collapsed' : ''}`} data-testid="workspace" data-sidebar-motion={sidebarMotion}>
    <div className="workspace-window-bar">
      <div className="workspace-drag-region drag" data-testid="titlebar" aria-hidden="true" />
      <button className="workspace-icon workspace-sidebar-toggle no-drag" data-testid={collapsed ? 'sidebar-expand' : 'sidebar-collapse'}
        onClick={(e) => toggleSidebar(e.detail > 0)}
        aria-expanded={!collapsed} aria-controls="workspace-sidebar" aria-keyshortcuts={onMac() ? 'Control+Meta+S' : 'Control+Shift+S'} title={`${collapsed ? t('Expand sidebar') : t('Collapse sidebar')} (${keys('⌃⌘S')})`}
        aria-label={collapsed ? t('Expand sidebar') : t('Collapse sidebar')}>
        <SidebarToggle className="sidebar-toggle-glyph rtl:-scale-x-100" size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
    {/* Reserve the final width once; only the absolute sidebar animates. */}
    <div className="workspace-sidebar-gap" aria-hidden="true" />
    <Sidebar.Container id="workspace-sidebar" className="workspace-sidebar" role="complementary" aria-label={t('Main navigation')} transition={sidebarTransition}>
      <div className="workspace-sidebar-inner">
      <div className="sidebar-titlebar" />
      <div className="workspace-sidebar-body">
        <button className="workspace-search no-drag" data-testid="search-open" aria-label={t('Search')} title={`${t('Search')} (${keys('⌘K')})`} onClick={search}><Search size={16} strokeWidth={1.75} aria-hidden="true" /><span>{t('Search')}</span><kbd>{keys('⌘K')}</kbd></button>
        <nav aria-label={t('Workspace')}>{links.slice(0, 2).map(nav)}</nav>
        <div className="workspace-folder-label">{t('Your workspace')}</div>
        <FoldersNav collapsed={collapsed} folders={folders} route={route} go={go} />
      </div>
      <div className="workspace-sidebar-footer">
        <FinishSetup collapsed={collapsed} />
        {nav(links[2])}
        {nav(links[3])}
        <div className="workspace-brand"><span className="workspace-wordmark"><Wordmark height={25} /></span></div>
      </div>
      </div>
    </Sidebar.Container>
    <div className="workspace-content">
      <header className="workspace-toolbar" data-note={note} data-recording-return={returnToRecording}>
        <div className="workspace-breadcrumb drag">
          <span className="workspace-history">
            <button data-testid="nav-back" className="workspace-icon no-drag" disabled={!back && !note} onClick={back ?? (() => go(''))} aria-label={t('Back')} title={`${t('Back')} (${keys('⌘[')})`}><ChevronLeft size={14} strokeWidth={1.75} className="rtl:-scale-x-100" aria-hidden="true" /></button>
            <button data-testid="nav-forward" className="workspace-icon no-drag" disabled={!forward} onClick={forward} aria-label={t('Forward')} title={`${t('Forward')} (${keys('⌘]')})`}><ChevronRight size={14} strokeWidth={1.75} className="rtl:-scale-x-100" aria-hidden="true" /></button>
          </span>
          <span data-testid="workspace-heading" aria-current="page" title={label}>{label}</span>
        </div>
      {returnToRecording && <button className="workspace-recording-link no-drag" data-testid="recording-return" data-paused={recording.paused}
        aria-label={t('Open {title}', { title: recording.title })} title={t('Open {title}', { title: recording.title })} onClick={() => go(`/note/${recording.meetingId}`)}>
        <LevelBars testId="recording-return-wave" height={16} paused={recording.paused} />
        <RecordingTime view={recording} testId="recording-return-time" className="recording-return-time" />
      </button>}
      <NotesSetup go={go} />
      <div id="workspace-actions" className="workspace-toolbar-actions" />
      </header>
      {children}

    </div>
  </div>
}
