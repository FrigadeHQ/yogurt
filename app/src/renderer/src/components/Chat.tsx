import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LibrarySource } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { keys, onMac } from '../keys'
import { MessageCircle } from './Icons'
import { setToastDialog } from './TrashToast'
import { AskConversation } from './AskConversation'
import { motion as timing } from '../motion'
import { rememberScrollPositions } from '../useScrollMemory'

/** The existing panel shell; its conversation and composer are shared with the Ask page. */
export function Ask({ id, recording, anchor, onSource }: { id: string; recording: boolean; anchor: HTMLElement | null; onSource: (s: LibrarySource, match?: string) => void }) {
  const [open, setOpen] = useState(false)
  const [conversationId, setConversationId] = useState<string>()
  const [conversationVersion, setConversationVersion] = useState(0)
  const [error, setError] = useState(false)
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 999px)').matches)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDialogElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const contents = useRef<HTMLDivElement>(null)
  const animations = useRef<Animation[]>([])
  const animateOpen = useRef(false)
  const closing = useRef(false)
  useEffect(() => { setOpen(false); setConversationId(undefined); setError(false); closing.current = false }, [id])
  useEffect(() => {
    const media = window.matchMedia('(max-width: 999px)')
    const change = () => setNarrow(media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  useEffect(() => {
    if (!open || conversationId) return
    let active = true
    void window.yogurt.conversations.current([{ kind: 'meeting', id }]).then(cid => { if (active) setConversationId(cid) }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [open, id, conversationId])
  // Ask grows out of its button and folds back into it. Only the surface stretches; the chat stays at its final size,
  // cropped to the surface so none of it shows outside, and the button and the surface trade places where they meet.
  const morph = (expand: boolean, animate = true) => {
    const shell = surface.current, body = contents.current, dialog = panel.current, button = trigger.current
    if (!shell || !body || !dialog || !button) return
    const running = animations.current.some(animation => animation.playState === 'running')
    const was = { transform: getComputedStyle(shell).transform, radius: getComputedStyle(shell).borderRadius, shell: getComputedStyle(shell).opacity,
      dialog: getComputedStyle(dialog).opacity, body: getComputedStyle(body).opacity, clip: getComputedStyle(body).clipPath, button: getComputedStyle(button).opacity }
    animations.current.forEach(animation => animation.cancel()); animations.current = []
    if (!animate) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const fade = dialog.animate([{ opacity: running ? was.dialog : expand ? 0 : 1 }, { opacity: expand ? 1 : 0 }],
        { duration: timing.micro, easing: timing.ease, fill: 'both' })
      animations.current = [fade]
      return fade
    }
    const from = button.getBoundingClientRect(), to = dialog.getBoundingClientRect(), box = body.getBoundingClientRect()
    const scaleX = from.width / to.width, scaleY = from.height / to.height
    const collapsed = `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${scaleX}, ${scaleY})`
    const buttonRadius = parseFloat(getComputedStyle(button).borderRadius)
    const collapsedRadius = `${buttonRadius / scaleX}px / ${buttonRadius / scaleY}px`
    const cropped = `inset(${from.top - box.top}px ${box.right - from.right}px ${box.bottom - from.bottom}px ${from.left - box.left}px round ${buttonRadius}px)`
    // The anchored shape settles without overshoot; text stays at its final size.
    const duration = expand ? timing.base : timing.askExit, easing = timing.ease, handoff = timing.micro
    const shape = shell.animate([
      { transform: running ? was.transform : expand ? collapsed : 'none', borderRadius: running ? was.radius : expand ? collapsedRadius : '12px' },
      { transform: expand ? 'none' : collapsed, borderRadius: expand ? '12px' : collapsedRadius },
    ], { duration, easing, fill: 'both' })
    const crop = body.animate([{ clipPath: running && was.clip !== 'none' ? was.clip : expand ? cropped : 'inset(0px round 12px)' }, { clipPath: expand ? 'inset(0px round 12px)' : cropped }],
      { duration, easing, fill: expand ? 'backwards' : 'forwards' })
    const content = body.animate([{ opacity: running ? was.body : expand ? 0 : 1 }, { opacity: expand ? 1 : 0 }],
      { duration: timing.micro, easing, fill: 'both' })
    // opening: the button fades as the surface appears over it; closing: the surface fades as it lands on the button
    const trade = { duration: handoff, delay: expand ? 0 : duration - handoff, easing, fill: 'both' as const }
    const cover = shell.animate([{ opacity: running ? was.shell : expand ? 0 : 1 }, { opacity: expand ? 1 : 0 }], trade)
    const label = button.animate([{ opacity: running ? was.button : expand ? 1 : 0 }, { opacity: expand ? 0 : 1 }], trade)
    animations.current = [shape, crop, content, cover, label]
    return shape
  }
  useEffect(() => () => animations.current.forEach((animation) => animation.cancel()), [])
  useLayoutEffect(() => {
    if (!open || !anchor || !panel.current) return
    const dialog = panel.current
    const position = () => {
      const bounds = anchor.getBoundingClientRect()
      dialog.style.setProperty('--chat-bottom', `${Math.max(16, innerHeight - bounds.bottom + 12)}px`)
      // Reminders and download notices must not push Ask over the recording controls.
      dialog.style.setProperty('--chat-height', `${narrow ? 440 : Math.max(0, bounds.height - 24)}px`)
    }
    position()
    // Native modal behavior makes the covered note inert at narrow widths; desktop stays editable.
    if (narrow) dialog.showModal(); else dialog.show()
    setToastDialog(narrow ? dialog : null)
    dialog.querySelector('textarea')?.focus({ preventScroll: true })
    morph(true, animateOpen.current)
    animateOpen.current = false
    const observer = new ResizeObserver(position)
    observer.observe(anchor)
    window.addEventListener('resize', position)
    return () => { observer.disconnect(); window.removeEventListener('resize', position); setToastDialog(null); dialog.close() }
  }, [open, narrow, anchor])
  const close = (animate = true) => {
    if (closing.current) return
    closing.current = true
    const exit = morph(false, animate)
    const done = () => {
      if (!closing.current) return
      closing.current = false
      panel.current?.close(); setOpen(false)
      trigger.current?.focus({ preventScroll: true })
    }
    if (exit) void exit.finished.then(done, () => {})
    else done()
  }

  const conversation = open && <dialog id="meeting-chat" ref={panel} data-testid="chat-panel" className="chat-panel no-drag"
    aria-labelledby="meeting-chat-title" aria-modal={narrow || undefined}
    onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented && !panel.current?.querySelector('.citation-card:not([data-ending-style])') && !(event.target as HTMLElement).closest('[role="alertdialog"], [role="dialog"], [role="menu"]')) { event.preventDefault(); event.stopPropagation(); close() } }}
    onCancel={event => { event.preventDefault(); close() }}>
    <div ref={surface} className="chat-morph-surface" aria-hidden="true" />
    <div ref={contents} className="chat-panel-contents">
      {error && <p role="alert">{t("Yogurt couldn't answer that.")}</p>}
      <AskConversation key={`${id}/${conversationVersion}`} id={conversationId ?? ''} pendingDraftKey={`meeting/${id}`} panel recording={recording} onSelect={next => { setConversationId(next); setConversationVersion(version => version + 1) }} onClose={() => close()}
        onExpand={conversationId ? () => { rememberScrollPositions(); close(false); window.yogurt.nav.go(`/chat/${conversationId}`) } : undefined}
        onDeleted={() => { close(false); setConversationId(undefined); window.yogurt.nav.go('/chat') }}
        onSource={(source, match) => { close(false); onSource(source, match) }} />
    </div>
  </dialog>
  return <>
    <button id="meeting-ask" ref={trigger} data-testid="chat-open" className="chat-trigger" type="button" aria-expanded={open} aria-controls="meeting-chat"
      title={onMac() ? t('Ask Yogurt (⌘J)') : `${t('Ask Yogurt')} (${keys('⌘J')})`} onClick={() => {
        // Programmatic and pointer opens share the same anchored motion.
        if (closing.current) { closing.current = false; morph(true) }
        animateOpen.current = true; setError(false); setOpen(true)
        panel.current?.querySelector('textarea')?.focus({ preventScroll: true })
      }}><MessageCircle size={16} strokeWidth={1.75} aria-hidden="true" /><span>{t('Ask Yogurt')}</span><kbd aria-hidden="true">{keys('⌘J')}</kbd></button>
    {anchor && createPortal(conversation, anchor)}
  </>
}
