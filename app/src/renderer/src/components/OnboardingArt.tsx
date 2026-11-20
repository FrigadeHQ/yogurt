import { AudioLines, CalendarDays, Mic, PhoneOff, Plus, Video, X } from 'lucide-react'
import type { PermissionKind } from '../../../shared/types'
import { Logo } from './Logo'
import { t } from '../../../shared/i18n'
import { RecordingPill } from './RecordingPill'
import rayPhoto from '../assets/onboarding/ray.webp'
import lincolnPhoto from '../assets/onboarding/lincoln.webp'
import mayaPhoto from '../assets/onboarding/maya.webp'
import macIcon from '../../../../build/icon.png'

/*
 * The first run's pictures, built from the app's own surfaces so they match both themes. Each shows what its screen
 * does, literally: the call written down, the two sides of the sound, the meeting from the calendar, the card when a
 * call starts, Them becoming names. They sit in an aria-hidden stage: the words next to them say the same thing.
 * Motion stops under prefers-reduced-motion, showing the end of each story.
 */

const d = (i: number) => ({ ['--i' as string]: i })

const ray = { name: 'Ray', photo: rayPhoto, width: 600, height: 556 }
const maya = { name: 'Maya', photo: mayaPhoto, width: 308, height: 308 }

function CallWindow({ welcome = false }: { welcome?: boolean }) {
  const you = { name: t('You'), photo: lincolnPhoto, width: 600, height: 556 }
  const people = welcome ? [ray, you] : [ray, you, maya]
  return <div className="ob-call">
    <div className="ob-call-grid">
      {people.map(person => <div key={person.photo} className="ob-tile" data-talking={person === ray}>
        <img src={person.photo} width={person.width} height={person.height} alt="" />
        <span className="ob-tile-name">{person.name}</span>
      </div>)}
    </div>
    <div className="ob-call-controls"><Mic size={13} /><Video size={14} /><PhoneOff size={13} /></div>
    {welcome && <RecordingPill illustration time="0:24" />}
  </div>
}

export function WelcomeArt() {
  return <div className="ob-scene ob-conversation"><CallWindow welcome /></div>
}

/** The picture explains the current permission. Permission status is in the step text. */
export function ScreenArt({ kind }: { kind: PermissionKind }) {
  switch (kind) {
    case 'mic':
    case 'systemAudio': return <RecordArt active={kind} />
    case 'calendar': return <CalendarArt />
    case 'notifications': return <NoticeArt />
    case 'accessibility': return <SpeakerNamesArt />
  }
}

/** The five bars match the website’s per-speaker meter. Only the source being explained speaks. */
function RecordArt({ active }: { active: 'mic' | 'systemAudio' }) {
  const lanes = [
    { kind: 'mic' as const, Icon: Mic, who: t('You'), from: t('Microphone') },
    { kind: 'systemAudio' as const, Icon: AudioLines, who: t('Everyone else'), from: t("Your Mac's sound") },
  ]
  return (
    <div data-testid="record-art" className="ob-scene">
      <div className="ob-card ob-record">
        {lanes.map(({ kind, Icon, who, from }, i) => (
          <div key={kind} className="ob-lane" data-active={kind === active} data-channel={kind} style={d(i)}>
            <span className="ob-lane-icon"><Icon size={15} strokeWidth={1.9} /></span>
            <span className="ob-lane-copy"><span className="ob-lane-who">{who}</span><span className="ob-lane-from">{from}</span></span>
            <span className="ob-wave">{[.54, .8, 1, .72, .42].map((peak, j) =>
              <i key={j} style={{ ['--peak' as string]: peak, ['--lag' as string]: `${-j * 30}ms` }} />)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** A day in the calendar, and the note that already knows the meeting's name and who's in it */
function CalendarArt() {
  const people = ['Ann Lee', 'Bo Park', t('You')]
  return (
    <div className="ob-scene ob-calendar">
      <div className="ob-card ob-day">
        <div className="ob-card-head"><CalendarDays size={12} strokeWidth={2} />{t('Today')}</div>
        <div className="ob-hours">
          {['9:00', '10:00', '11:00', '12:00'].map((h) => <span key={h} className="ob-hour">{h}</span>)}
          <span className="ob-event"><span className="ob-event-title">{t('Design review')}</span><span className="ob-event-time">10:00</span></span>
        </div>
      </div>
      <div className="ob-card ob-meeting-note">
        <p className="ob-note-meta"><CalendarDays size={11} strokeWidth={2} />{t('Today, 10:00')}</p>
        <p className="ob-doc-title">{t('Design review')}</p>
        <ul className="ob-people">{people.map((p, i) => <li key={p} style={d(i)}><span>{p.slice(0, 1)}</span>{p}</li>)}</ul>
        <span className="ob-skeleton" /><span className="ob-skeleton ob-skeleton-short" />
      </div>
    </div>
  )
}

/** A still example of the reminder that appears when a call starts. */
function NoticeArt() {
  return (
    <div className="ob-scene ob-notice">
      <div className="ob-prompt" data-testid="notice-art">
        <img src={macIcon} alt="" className="ob-prompt-icon" />
        <span className="ob-prompt-copy"><span className="ob-prompt-label">{t('Take notes?')}</span><span className="ob-prompt-title">{t('{app} call', { app: 'Zoom' })}</span></span>
        <span className="ob-prompt-button">{t('Start recording')}</span>
        <X size={13} className="ob-prompt-close" />
      </div>
    </div>
  )
}

/** Why Accessibility: the names the call shows, and the same lines turning from Them into those names */
export function SpeakerNamesArt() {
  const lines: { who?: string; text: string }[] = [
    { who: ray.name, text: t("I'll send a draft by Friday.") },
    { text: t("I'll review it that afternoon.") },
    { who: maya.name, text: t('Then I can get the final copy ready for Tuesday.') },
  ]
  return (
    <div data-testid="speaker-names-art" className="ob-scene ob-names">
      <CallWindow />
      <div className="ob-card ob-transcript">
        {lines.map((line, i) => <p key={i} className="ob-turn">
          {line.who ? <b className="ob-swap" style={d(i)}><span className="ob-swap-from">{t('Them')}</span><span className="ob-swap-to">{line.who}</span></b>
            : <b>{t('You')}</b>}
          {line.text}
        </p>)}
      </div>
    </div>
  )
}

/** Where to click in System Settings: its pane with Yogurt in the list, the switch turning on, and + for when it isn't listed */
export function SettingsWindowArt({ pane, section }: { pane: string; section?: string }) {
  return (
    <div data-testid="settings-window-art" className="ob-settings">
      <div className="ob-settings-side">
        <span className="ob-settings-dots"><i /><i /><i /></span>
        {[0, 1, 2, 3, 4, 5].map((k) => <span key={k} className="ob-settings-nav" data-current={k === 4} />)}
      </div>
      <div className="ob-settings-pane">
        <p className="ob-settings-title">{pane}</p>
        {section && <p className="ob-settings-section">{section}</p>}
        <div className="ob-settings-list">
          <div className="ob-settings-row ob-settings-other"><span className="ob-app-icon" /><span className="ob-app-name" /><span className="ob-switch" /></div>
          <div className="ob-settings-row ob-settings-yogurt">
            <span className="ob-app-icon ob-app-yogurt"><Logo size={12} className="text-[#fff]" /></span>
            <span className="ob-settings-app">Yogurt</span>
            <span className="ob-switch ob-switch-on" />
          </div>
          <div className="ob-settings-tools"><Plus size={11} strokeWidth={2.25} /><span className="ob-settings-minus" /></div>
        </div>
      </div>
    </div>
  )
}

export { DownloadBlob as ReadyArt } from './DownloadBlob'
