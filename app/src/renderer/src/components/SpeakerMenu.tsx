import { Popover } from '@base-ui/react/popover'
import { useState, type ReactNode } from 'react'
import { ArrowLeft, Check, Plus } from './Icons'
import { t } from '../../../shared/i18n'
import { toasts } from './TrashToast'
import { useMyName } from './People'

const same = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()

type Target = { ids: number[] } | { from: string | null }

/**
 * Who said a turn of the other side, fixed by the person: its name opens a list of the meeting's attendees, the other
 * speakers in the transcript, and a new name. Once one is picked: just this turn (a wrong label), or every line of the
 * speaker it had (naming a voice, Speaker 3 → Ahmed). The mic's side is always them, so it never has one.
 */
export function SpeakerMenu({ meetingId, current, currentName, ids, people, speakers, children, className, ...data }: {
  meetingId: string
  /** the speaker the turn has now; null: Them */
  current: string | null
  /** how the turn's speaker reads (Audio for an uploaded recording's marker) */
  currentName: string
  /** the turn's saved lines */
  ids: number[]
  /** the meeting's attendees */
  people: string[]
  /** every name in the transcript's other side */
  speakers: string[]
  /** the name as the turn shows it */
  children: ReactNode
  className?: string
  'data-color'?: number
  'data-folder-color'?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger data-testid="transcript-who" {...data} className={`${className ?? ''} speaker-menu-trigger`}
        title={t('Change who is speaking')}>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={12} positionMethod="fixed" className="speaker-menu-positioner">
          <Popover.Popup data-testid="speaker-menu" data-anchor="start" aria-label={t('Who is speaking?')} className="menu-entry speaker-menu">
            {/* only while open: a long transcript has a menu on every turn, and each would read Settings for the person's name */}
            {open && <Choices meetingId={meetingId} current={current} currentName={currentName} ids={ids} people={people} speakers={speakers} onDone={() => setOpen(false)} />}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function Choices({ meetingId, current, currentName, ids, people, speakers, onDone }: {
  meetingId: string; current: string | null; currentName: string; ids: number[]; people: string[]; speakers: string[]; onDone: () => void
}) {
  const myName = useMyName()
  const [picked, setPicked] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [saving, setSaving] = useState(false)

  const isCurrent = (n: string) => current !== null && same(n, current)
  // the person themself is never the other side
  const attendees = [...new Map(people.filter(n => n.trim() && !(myName && same(n, myName))).map(n => [n.trim().toLocaleLowerCase(), n.trim()])).values()]
  const others = speakers.filter(n => !attendees.some(a => same(a, n)))
  const name = typed.replace(/\s+/g, ' ').trim()

  const apply = async (target: Target) => {
    if (!picked || saving) return
    setSaving(true)
    try {
      if (!await window.yogurt.transcript.setSpeaker(meetingId, target, picked)) throw new Error('not changed')
      onDone()
    } catch {
      setSaving(false)
      toasts.add({ title: t("Yogurt couldn't make that change. Try again.") })
    }
  }

  const option = (n: string) => (
    <button key={n} type="button" data-testid="speaker-option" aria-current={isCurrent(n) || undefined} disabled={isCurrent(n)}
      className="speaker-menu-item" onClick={() => setPicked(n)}>
      <span className="truncate">{n}</span>{isCurrent(n) && <Check size={13} aria-hidden="true" className="ms-auto shrink-0" />}
    </button>
  )

  if (picked !== null) return <>
    <button type="button" data-testid="speaker-back" className="speaker-menu-back" onClick={() => setPicked(null)} disabled={saving}>
      <ArrowLeft size={13} aria-hidden="true" />{t('Change to {name}', { name: picked })}
    </button>
    <button type="button" data-testid="speaker-this-turn" className="speaker-menu-item" disabled={saving}
      onClick={() => void apply({ ids })}>{t('Just this turn')}</button>
    <button type="button" data-testid="speaker-all-lines" className="speaker-menu-item" disabled={saving}
      onClick={() => void apply({ from: current })}>
      {current === null ? t('All lines marked Them') : t("All of {name}'s lines", { name: currentName })}
    </button>
  </>

  return <>
    <p className="speaker-menu-title">{t('Who is speaking?')}</p>
    {attendees.length > 0 && <section aria-label={t('Attendees')}>
      <h4 className="speaker-menu-heading">{t('Attendees')}</h4>
      {attendees.map(option)}
    </section>}
    {others.length > 0 && <section aria-label={t('Speakers')}>
      <h4 className="speaker-menu-heading">{t('Speakers')}</h4>
      {others.map(option)}
    </section>}
    <form className="speaker-menu-new" onSubmit={e => { e.preventDefault(); if (name && !isCurrent(name)) setPicked(name) }}>
      <Plus size={13} aria-hidden="true" className="shrink-0 text-muted" />
      <input data-testid="speaker-new" value={typed} maxLength={200} placeholder={t('New name…')} aria-label={t('New name')}
        onChange={e => setTyped(e.target.value)} />
    </form>
  </>
}
