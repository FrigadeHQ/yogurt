import { useEffect, useRef, useState } from 'react'
import { DirectionProvider } from '@base-ui/react/direction-provider'
import { Menu } from '@base-ui/react/menu'
import { Tooltip } from '@base-ui/react/tooltip'
import { Logo as CornerMark } from './Logo'
import { ActionTooltipPopup } from './ActionTooltipPopup'
import { Keyboard, Megaphone, MessageCircle, RotateCw, SidebarSettings as Settings, Trash2 } from './Icons'
import type { UpdateStatus } from '../../../shared/types'
import { dirOf, language, t } from '../../../shared/i18n'
import { keys } from '../keys'
import { cornerLinks, cornerRows, knownRelease, newerRelease, restartState } from './cornerMenuModel'

const seenKey = 'yogurt.corner-menu.opened-release'
// Older builds saved the ready version here when the menu was opened.
const downloadedKey = 'yogurt.corner-menu.noticed-update'
function readVersion(key: string) {
  try { return localStorage.getItem(key) } catch { return null }
}
function saveVersion(key: string, version: string | null) {
  try {
    if (version === null) localStorage.removeItem(key)
    else localStorage.setItem(key, version)
  } catch { /* still remembered for this session */ }
}

export function CornerMenu({ visible, section, recording, go, shortcuts }: { visible: boolean; section: string; recording: boolean; go(route: string): void; shortcuts(): void }) {
  const [{ status, downloaded }, setUpdate] = useState<{ status?: UpdateStatus; downloaded?: string | null }>({})
  const [seen, setSeen] = useState(() => readVersion(seenKey))
  const [open, setOpen] = useState(false)
  const [entering, setEntering] = useState(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const restarting = useRef(false)
  const button = useRef<HTMLButtonElement>(null)
  const destination = useRef<'shortcuts' | 'settings' | 'trash' | null>(null)
  // A native shortcut or a narrow resize can hide the trigger while its portalled menu is open.
  useEffect(() => { if (!visible) setOpen(false) }, [visible])
  useEffect(() => {
    let active = true, updated = false
    let waiting = readVersion(downloadedKey)
    const update = (next: UpdateStatus) => {
      if (!active) return
      updated = true
      if (next.state === 'ready' && next.next && next.next !== waiting) {
        waiting = next.next
        saveVersion(downloadedKey, waiting)
      } else if (waiting && next.state !== 'ready' && !newerRelease(waiting, next.version)) {
        // A restart request can succeed before the process actually exits.
        waiting = null
        saveVersion(downloadedKey, null)
      }
      setUpdate({ status: next, downloaded: waiting })
      if (next.state !== 'ready') setFailed(false)
    }
    const off = window.yogurt.updates.onStatus(update)
    void window.yogurt.updates.status().then(next => { if (!updated) update(next) }).catch(() => {})
    const sync = (event: StorageEvent) => {
      if (event.key === seenKey || event.key === null) setSeen(readVersion(seenKey))
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
  const showRestart = restart !== 'hidden' || !!downloaded
  const updateVersion = downloaded || status?.next
  const install = async () => {
    if (restart !== 'ready' || restarting.current) return
    restarting.current = true; setPending(true); setFailed(false)
    try {
      if (await window.yogurt.updates.restart()) setOpen(false)
      else setFailed(true)
    } catch { setFailed(true) }
    finally { restarting.current = false; setPending(false) }
  }
  const finishTransition = (isOpen: boolean) => {
    if (isOpen) { setEntering(false); return }
    const next = destination.current
    if (!next) return
    destination.current = null
    // Finish the menu's focus lifecycle before the destination can accept input.
    button.current?.focus({ preventScroll: true })
    if (next === 'shortcuts') shortcuts()
    else go('/' + next)
  }
  const labels = {
    news: t("What's new"), github: t('Star us on GitHub'), discord: t('Join Discord'),
    shortcuts: t('Keyboard shortcuts'), feedback: t('Send feedback'), settings: t('Settings'), trash: t('Trash'),
  }
  const glyphs = { news: Megaphone, shortcuts: Keyboard, feedback: MessageCircle, settings: Settings, trash: Trash2 }
  const shortcutKeys = { shortcuts: '⌘/', settings: '⌘,', trash: '⌘3' }
  const rowDot = <span className="corner-row-dot" aria-hidden="true" />
  return <DirectionProvider direction={dirOf(language())}>
    <div className="workspace-corner">
      <Menu.Root modal={false} open={visible && open} highlightItemOnHover={!entering} onOpenChangeComplete={finishTransition} onOpenChange={next => {
        setOpen(next)
        setEntering(next)
        if (next) { destination.current = null; setFailed(false) }
      }}>
        <Tooltip.Root disabled={open}>
          <Menu.Trigger ref={button} data-testid="corner-menu-button" className="workspace-icon ghost-btn corner-trigger no-drag"
            aria-label={t('Help and settings')} aria-description={showRestart ? t('Update ready') : undefined}
            render={<Tooltip.Trigger delay={180} />}>
            <span aria-hidden="true"><CornerMark size={18} className="corner-brand" /></span>
            {showRestart && <span className="corner-badge" data-testid="corner-notice-dot" aria-hidden="true" />}
          </Menu.Trigger>
          <ActionTooltipPopup label={t('Help and settings')} align="start" />
        </Tooltip.Root>
        <Menu.Portal>
          <Menu.Positioner side="top" align="start" sideOffset={8} collisionPadding={8} positionMethod="fixed" className="corner-position">
            <Menu.Popup aria-label={t('Yogurt menu')} data-testid="corner-menu" data-motion="instant" className="menu-entry corner-menu"
              data-suppress-hover={entering || undefined} onPointerMove={event => {
                if (entering && (event.movementX || event.movementY)) setEntering(false)
              }}
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
                const unreadNews = id === 'news' && unread
                return <Menu.LinkItem key={id} closeOnClick label={labels[id]} href={cornerLinks[id]} target="_blank" rel="noopener noreferrer"
                  aria-description={unreadNews ? t('New') : undefined} onClick={id === 'news' ? () => void rememberRelease() : undefined}>
                  {icon}<span>{labels[id]}</span>{unreadNews && rowDot}
                </Menu.LinkItem>
              })}
              {showRestart && <Menu.Item closeOnClick={false} data-testid="update-restart" disabled={restart !== 'ready' || pending} onClick={() => void install()}>
                <RotateCw size={15} aria-hidden="true" /><span>{updateVersion ? t('Restart to update · {version}', { version: updateVersion }) : t('Restart')}
                  {recording && <span className="corner-detail">{t('You can restart after recording')}</span>}</span>
                {rowDot}
              </Menu.Item>}
              {restart === 'ready' && failed && <p className="corner-detail" role="alert">{t("Yogurt couldn't restart. Try again.")}</p>}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  </DirectionProvider>
}
