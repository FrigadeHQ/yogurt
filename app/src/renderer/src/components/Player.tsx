import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { Menu } from '@base-ui/react/menu'
import { Modal, ModalClose } from './Modal'
import { InlineError } from './InlineError'
import { Ellipsis, Pause, Play, Trash2 } from 'lucide-react'
import { language, t } from '../../../shared/i18n'
import { clock } from '../../../shared/transcript'
import { Swap } from './Swap'
import { recordingDeletedToast } from './TrashToast'

type Track = 'me' | 'them'
export type PlayerHandle = { playFrom: (ms: number) => void }
const RATES = [1, 1.5, 2]
/** a track further than this from the other is put back in step */
const DRIFT_S = 0.08

/**
 * Both sides of the meeting, played together: one audio element per track, kept in step with the longer one.
 * Two elements seek exactly (no decoding the whole meeting into memory) and keep the pitch at 1.5× and 2×.
 * What the button shows comes from the elements themselves, so a stop it did not cause still shows.
 */
/**
 * `onTime` gets the spot while it plays and when it is moved (paused too, so the line stays marked where it stopped),
 * with `seek` for an explicit move, and null once the meeting or panel changes; `onPlaying` whether any side is playing.
 */
type PlayerProps = { id: string; tracks: Track[]; ref?: Ref<PlayerHandle>; onTime?: (ms: number | null, seek?: boolean) => void; onPlaying?: (on: boolean) => void }
export function Player(props: PlayerProps) { return props.tracks.length ? <MeetingPlayer key={props.id} {...props} /> : null }
function MeetingPlayer({ id, tracks, ref, onTime, onPlaying }: PlayerProps) {
  const [confirm, setConfirm] = useState(false)
  const [deleted, setDeleted] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const els = useRef<Partial<Record<Track, HTMLAudioElement>>>({})
  const owned = useRef(new Set<HTMLAudioElement>())
  /** tracks that could not be read: dropped, and the other plays on */
  const [broken, setBroken] = useState<Track[]>([])
  const pendingPlayFrom = useRef<number | undefined>(undefined)
  const shown = tracks.filter((tr) => !broken.includes(tr))
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState(1)
  const onTimeRef = useRef(onTime)
  onTimeRef.current = onTime
  const onPlayingRef = useRef(onPlaying)
  onPlayingRef.current = onPlaying
  /** nothing is marked until it has played or been moved */
  const touched = useRef(false)
  const rateRef = useRef(rate)
  rateRef.current = rate

  const all = () => shown.map((tr) => els.current[tr]).filter((a): a is HTMLAudioElement => !!a)
  const lenOf = (a: HTMLAudioElement) => (Number.isFinite(a.duration) ? a.duration : 0)
  /** the longest track sets the time; the other follows it */
  const lead = () => all().reduce<HTMLAudioElement | undefined>((a, b) => (!a || lenOf(b) > lenOf(a) ? b : a), undefined)
  const anyPlaying = () => all().some((a) => !a.paused)
  const start = (a: HTMLAudioElement) => {
    a.playbackRate = rateRef.current
    void a.play().catch((e: unknown) => { if ((e as Error)?.name !== 'AbortError') console.error('playing a track failed', e) })
  }

  const seek = (s: number) => {
    const on = anyPlaying()
    for (const a of all()) {
      a.currentTime = Math.min(s, lenOf(a) || s)
      // a shorter side that had ended plays again once the new spot is inside it
      if (on && a.paused && s < lenOf(a)) start(a)
    }
    setTime(s)
    touched.current = true
    onTimeRef.current?.(s * 1000, true)
  }
  const play = () => {
    const l = lead()
    if (l && lenOf(l) && l.currentTime >= lenOf(l) - 0.05) seek(0)
    touched.current = true
    for (const a of all()) if (!lenOf(a) || a.currentTime < lenOf(a)) start(a)
  }
  const pause = () => { for (const a of all()) a.pause() }

  const playFrom = (ms: number) => {
    if (all().some(a => a.readyState === 0)) { pendingPlayFrom.current = ms; return }
    pendingPlayFrom.current = undefined
    seek(Math.max(0, ms / 1000 - 1)); play()
  }
  useImperativeHandle(ref, () => ({ playFrom }))
  useEffect(() => { if (pendingPlayFrom.current !== undefined) playFrom(pendingPlayFrom.current) }, [broken])

  useEffect(() => { for (const a of all()) a.playbackRate = rate }, [rate])
  useEffect(() => { setBroken([]); setPlaying(false); setTime(0); setDuration(0); touched.current = false }, [id])
  // another meeting, or the panel closing: stop
  // React lets go of the elements (els) before this cleanup runs, and an audio let go keeps playing: pause every one it had
  useEffect(() => () => { for (const a of owned.current) a.pause(); owned.current.clear(); onTimeRef.current?.(null) }, [id])
  useEffect(() => { onPlayingRef.current?.(playing) }, [playing])

  const changed = () => setPlaying(anyPlaying())
  const tick = (a: HTMLAudioElement) => {
    // A queued timeupdate can still carry the old clock during a seek. The requested position owns the UI until
    // the media element has settled; otherwise a drag briefly sends the thumb and transcript backwards.
    if (a !== lead() || a.seeking) return
    setTime(a.currentTime)
    if (touched.current) onTimeRef.current?.(a.currentTime * 1000)
    for (const b of all()) {
      if (b !== a && !b.paused && !b.seeking && a.currentTime < lenOf(b) && Math.abs(b.currentTime - a.currentTime) > DRIFT_S) b.currentTime = a.currentTime
    }
  }
  const failed = (tr: Track, a: HTMLAudioElement) => {
    console.error('a track of the recording could not be played', tr, a.error?.code, a.error?.message)
    setBroken((b) => (b.includes(tr) ? b : [...b, tr]))
  }

  const rateText = t('{rate}×', { rate: new Intl.NumberFormat(language()).format(rate) })
  const fill = duration ? (time / duration) * 100 : 0
  const note = broken.length === 0 ? null : shown.length === 0 ? t("This recording can't be played.") : t("Part of this recording can't be played.")
  if (deleted) return null
  return (
    <div data-testid="player" className="mx-4 mb-4 rounded-xl border border-line bg-float p-2 text-xs text-muted shadow-[var(--shadow-soft)]">
      {shown.map((tr) => (
        <audio key={tr} data-testid={`player-audio-${tr}`} data-track={tr} preload="metadata" src={`yogurt-audio://${id}/${tr}`}
          ref={(a) => { if (a) { els.current[tr] = a; owned.current.add(a) } else delete els.current[tr] }}
          onLoadedMetadata={() => { setDuration(Math.max(0, ...all().map(lenOf))); if (pendingPlayFrom.current !== undefined) playFrom(pendingPlayFrom.current) }}
          onTimeUpdate={(e) => tick(e.currentTarget)}
          onPlay={changed} onPause={changed}
          onEnded={(e) => { if (e.currentTarget === lead()) pause(); changed() }}
          onError={(e) => { failed(tr, e.currentTarget); changed() }} />
      ))}
      {note && <p data-testid="player-note" role="status" className={shown.length ? 'px-1.5 pb-1.5' : 'px-1.5 py-1'}>{note}</p>}
      <div className="flex items-center gap-2.5">
        {shown.length > 0 && <>
          <button data-testid="player-toggle" aria-label={playing ? t('Pause') : t('Play')} onClick={() => (playing ? pause() : play())}
            className="player-btn flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-accent-ink">
            <Swap show={playing ? 'pause' : 'play'} options={{ play: <Play size={13} fill="currentColor" strokeWidth={0} className="ms-0.5" />, pause: <Pause size={13} fill="currentColor" strokeWidth={0} /> }} />
          </button>
          <span className="w-9 shrink-0 text-end tabular-nums">{clock(time * 1000)}</span>
          <input data-testid="player-scrubber" type="range" min={0} max={duration || 0} step={0.1} value={Math.min(time, duration || 0)} aria-label={t('Position')}
            onChange={(e) => seek(Number(e.target.value))} className="scrubber min-w-0 flex-1" style={{ ['--fill' as string]: `${fill}%` }} />
          <span className="w-9 shrink-0 tabular-nums">{clock(duration * 1000)}</span>
          <button data-testid="player-speed" aria-label={t('Playback speed {rate}', { rate: rateText })}
            onClick={() => setRate((r) => RATES[(RATES.indexOf(r) + 1) % RATES.length])}
            className="ghost-btn h-7 w-10 shrink-0 justify-center !px-0 tabular-nums">
            {rateText}
          </button>
        </>}
          <Menu.Root modal={false}>
            <Menu.Trigger ref={menuButton} data-testid="recording-menu" aria-label={t('More')} title={t('More')}
              className="bar-btn ms-auto grid size-7 shrink-0 place-items-center rounded-md text-muted"><Ellipsis size={17} aria-hidden="true" /></Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner side="top" align="end" sideOffset={6} className="ask-menu-positioner">
                <Menu.Popup className="menu-entry ask-actions-menu" aria-label={t('More')} finalFocus={confirm ? false : menuButton} onKeyDown={e => { if (e.key === 'Escape') e.stopPropagation() }}>
                  <Menu.Item data-testid="recording-delete" className="text-danger" onClick={() => { pause(); menuButton.current?.focus(); setConfirm(true) }}>
                    <Trash2 size={14} aria-hidden="true" />{t('Delete recording')}
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
      </div>
      {confirm && <DeleteRecording id={id} onCancel={() => { setConfirm(false); menuButton.current?.focus() }} onDeleted={() => {
        for (const a of owned.current) { a.pause(); a.removeAttribute('src'); a.load() }
        setConfirm(false); setDeleted(true); setPlaying(false); onTimeRef.current?.(null); onPlayingRef.current?.(false)
      }} />}
    </div>
  )
}

export function DeleteRecording({ id, onCancel, onDeleted }: { id: string; onCancel: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<'not-transcribed' | 'recording' | 'failed'>()
  const yes = async () => {
    if (busy) return
    setBusy(true); setFailed(undefined)
    const result = await window.yogurt.audio.delete(id).catch(() => 'failed' as const)
    setBusy(false)
    if (result === 'deleted') void recordingDeletedToast()
    if (result === 'deleted' || result === 'missing') onDeleted()
    else setFailed(result === 'not-transcribed' || result === 'recording' ? result : 'failed')
  }
  return <Modal testId="recording-delete-confirm" role="alertdialog" title={t('Delete recording?')}
    description={t('The audio is deleted for good. Your transcript and notes stay.')} busy={busy} onCancel={onCancel}>
    {failed && <InlineError testId="recording-delete-failed" className="inline-error-in-dialog"><span>{failed === 'not-transcribed' ? t('Keep the audio until the transcript is saved.')
      : failed === 'recording' ? t('Stop the recording first, then try again.') : t("Couldn't delete the recording. Try again.")}</span></InlineError>}
    <div className="modal-actions">
      <button data-testid="recording-delete-yes" className="modal-button danger" disabled={busy} onClick={() => void yes()}>{t('Delete recording')}</button>
      <ModalClose data-testid="recording-delete-cancel" data-dialog-cancel className="modal-button" disabled={busy}>{t('Cancel')}</ModalClose>
    </div>
  </Modal>
}
