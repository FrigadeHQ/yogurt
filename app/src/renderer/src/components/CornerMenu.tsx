import { useEffect, useRef, useState } from 'react'
import { DirectionProvider } from '@base-ui/react/direction-provider'
import { Menu } from '@base-ui/react/menu'
import { Tooltip } from '@base-ui/react/tooltip'
import { Logo as CornerMark } from './Logo'
import { ActionTooltipPopup } from './ActionTooltipPopup'
import { BookOpen, Keyboard, Megaphone, MessageCircle, RotateCw, SidebarSettings as Settings, Trash2 } from './Icons'
import type { UpdateStatus } from '../../../shared/types'
import { dirOf, language, t } from '../../../shared/i18n'
import { keys } from '../keys'
import { cornerLinks, cornerRows, knownRelease, newerRelease, restartState } from './cornerMenuModel'

const seenKey = 'yogurt.corner-menu.opened-release'
const noticedReleaseKey = 'yogurt.corner-menu.noticed-release'
const noticedUpdateKey = 'yogurt.corner-menu.noticed-update'
function readVersion(key: string) {
  try { return localStorage.getItem(key) } catch { return null }
}
function saveVersion(key: string, version: string) {
  try { localStorage.setItem(key, version) } catch { /* still remembered for this session */ }
}
function readNotices() {
  return { release: readVersion(noticedReleaseKey), update: readVersion(noticedUpdateKey) }
}

export function CornerMenu({ section, recording, go, shortcuts }: { section: string; recording: boolean; go(route: string): void; shortcuts(): void }) {
  const [status, setStatus] = useState<UpdateStatus>()
  const [seen, setSeen] = useState(() => readVersion(seenKey))
  const [noticed, setNoticed] = useState(readNotices)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const restarting = useRef(false)
  const button = useRef<HTMLButtonElement>(null)
  const destination = useRef<'shortcuts' | 'settings' | 'trash' | null>(null)
  useEffect(() => {
    let active = true, updated = false
    const update = (next: UpdateStatus) => {
      if (!active) return
      updated = true
      setStatus(next)
      if (next.state !== 'ready') setFailed(false)
    }
    const off = window.yogurt.updates.onStatus(update)
    void window.yogurt.updates.status().then(next => { if (!updated) update(next) }).catch(() => {})
    const sync = (event: StorageEvent) => {
      if (event.key === seenKey || event.key === null) setSeen(readVersion(seenKey))
      if (event.key === noticedReleaseKey || event.key === noticedUpdateKey || event.key === null) setNoticed(readNotices())
    }
    window.addEventListener('storage', sync)
    return () => { active = false; off(); window.removeEventListener('storage', sync) }
  }, [])

  const release = knownRelease(status)
  const unread = newerRelease(release, seen)
  const rememberRelease = async () => {
    const opened = release ?? knownRelease(await window.yogurt.updates.status().catch(() => undefined))
    if (!opened || !newerRelease(opened, seen) || !newerRelease(opened, readVersion(seenKey))) return
    setSeen(opened)
    saveVersion(seenKey, opened)
  }
  const restart = restartState(status, recording)
  const ready = restart !== 'hidden'
  const install = async () => {
    if (restart !== 'ready' || restarting.current) return
    restarting.current = true; setPending(true); setFailed(false)
    try {
      if (await window.yogurt.updates.restart()) setOpen(false)
      else setFailed(true)
    } catch { setFailed(true) }
    finally { restarting.current = false; setPending(false) }
  }
  const finishClose = (isOpen: boolean) => {
    const next = destination.current
    if (isOpen || !next) return
    destination.current = null
    // Finish the menu's focus lifecycle before the destination can accept input.
    button.current?.focus({ preventScroll: true })
    if (next === 'shortcuts') shortcuts()
    else go('/' + next)
  }
  const labels = {
    news: t("What's new"), github: t('Star us on GitHub'), discord: t('Join Discord'),
    shortcuts: t('Keyboard shortcuts'), feedback: t('Send feedback'), help: t('Help'), settings: t('Settings'), trash: t('Trash'),
  }
  const glyphs = { news: Megaphone, shortcuts: Keyboard, feedback: MessageCircle, help: BookOpen, settings: Settings, trash: Trash2 }
  const shortcutKeys = { shortcuts: '⌘/', settings: '⌘,', trash: '⌘3' }
  const updateVersion = ready && !status?.dismissed ? status?.next || status?.version || 'ready' : null
  const newRelease = unread && newerRelease(release, noticed.release)
  const newUpdate = !!updateVersion && updateVersion !== noticed.update
  const badge = !open && (newRelease || newUpdate)
  // Seeing the menu clears its dot. Only following the changelog clears the New badge.
  useEffect(() => {
    if (!open || (!newRelease && !newUpdate)) return
    const next = { ...noticed }
    if (newRelease && release) {
      next.release = release
      saveVersion(noticedReleaseKey, release)
    }
    if (newUpdate && updateVersion) {
      next.update = updateVersion
      saveVersion(noticedUpdateKey, updateVersion)
    }
    setNoticed(next)
  }, [open, newRelease, newUpdate, release, updateVersion, noticed])
  return <DirectionProvider direction={dirOf(language())}>
    <div className="workspace-corner">
      <Menu.Root modal={false} open={open} onOpenChangeComplete={finishClose} onOpenChange={next => {
        setOpen(next)
        if (next) { destination.current = null; setFailed(false) }
      }}>
        <Tooltip.Root disabled={open}>
          <Menu.Trigger ref={button} data-testid="corner-menu-button" className="workspace-icon ghost-btn corner-trigger no-drag"
            aria-label={t('Help and settings')} aria-description={badge ? (newUpdate ? t('Update ready') : t("What's new")) : undefined}
            render={<Tooltip.Trigger delay={180} />}>
            <span aria-hidden="true"><CornerMark size={18} className="corner-brand" /></span>
            {badge && <span className="corner-badge" data-testid="corner-notice-dot" aria-hidden="true" />}
          </Menu.Trigger>
          <ActionTooltipPopup label={t('Help and settings')} align="start" />
        </Tooltip.Root>
        <Menu.Portal>
          <Menu.Positioner side="top" align="start" sideOffset={8} collisionPadding={8} positionMethod="fixed" className="corner-position">
            <Menu.Popup aria-label={t('Yogurt menu')} data-testid="corner-menu" data-motion="instant" className="menu-entry corner-menu"
              finalFocus={destination.current ? false : undefined}>
              {cornerRows.map(id => {
                const Icon = id === 'github' || id === 'discord' ? null : glyphs[id]
                const icon = Icon ? <Icon size={15} aria-hidden="true" /> : <span className={'corner-mark ' + id} aria-hidden="true" />
                if (id === 'settings' || id === 'trash' || id === 'shortcuts') {
                  return <Menu.Item key={id} label={labels[id]} data-testid={id === 'settings' ? 'settings-open' : id === 'trash' ? 'nav-trash' : 'corner-shortcuts'}
                    aria-current={section === '/' + id ? 'page' : undefined} onClick={() => { destination.current = id; setOpen(false) }}>
                    {icon}<span>{labels[id]}</span><kbd>{keys(shortcutKeys[id])}</kbd>
                  </Menu.Item>
                }
                return <Menu.LinkItem key={id} closeOnClick label={labels[id]} href={cornerLinks[id]} target="_blank" rel="noopener noreferrer"
                  onClick={id === 'news' ? () => void rememberRelease() : undefined}>
                  {icon}<span>{labels[id]}</span>{id === 'news' && unread && <span className="corner-new">{t('New')}</span>}
                </Menu.LinkItem>
              })}
              {ready && <Menu.Item closeOnClick={false} data-testid="update-restart" disabled={recording || pending} onClick={() => void install()}>
                <RotateCw size={15} aria-hidden="true" /><span>{status?.next ? t('Restart to update · {version}', { version: status.next }) : t('Restart')}
                  {recording && <span className="corner-detail">{t('You can restart after recording')}</span>}</span>
                <span className="corner-row-dot" aria-hidden="true" />
              </Menu.Item>}
              {ready && failed && !recording && <p className="corner-detail" role="alert">{t("Yogurt couldn't restart. Try again.")}</p>}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  </DirectionProvider>
}
