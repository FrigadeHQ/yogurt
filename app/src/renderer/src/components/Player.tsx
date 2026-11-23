import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { Menu } from '@base-ui/react/menu'
import { Modal, ModalClose } from './Modal'
import { InlineError } from './InlineError'
import { Ellipsis, Pause, Play, Trash2 } from './Icons'
import { language, t } from '../../../shared/i18n'
import { clock } from '../../../shared/transcript'
import { Swap } from './Swap'
import { recordingDeletedToast } from './TrashToast'

type Track = 'me' | 'them'
export type PlayerHandle = {
  playFrom: (ms: number) => void
  /** one line on its own: from just before it to just after it, the other side muted, then it stops */
  playLine: (startMs: number, endMs: number, track: Track) => void
}
const RATES = [1, 1.5, 2]
/** a track further than this from the other is put back in step */
const DRIFT_S = 0.08
/** a line played on its own starts this much before it (whisper's start can be a little late), not the full second
 * playFrom gives, which would bring in the end of the person before */
const LINE_LEAD_S = 0.25
/** and stops this long after its end, so the last word isn't clipped */
const LINE_TAIL_S = 0.3
/** what was asked to play before every track could seek: the whole meeting from ms, or one line */
type Want = { ms: number; line?: { endMs: number; track: Track } }

/**
 * Both sides of the meeting, played together: one audio element per track, kept in step with the longer one.
 * Two elements seek exactly (no decoding the whole meeting into memory) and keep the pitch at 1.5× and 2×.
 * What the button shows comes from the elements themselves, so a stop it did not cause still shows.
 */
/**
 * `onTime` gets the spot while it plays and when it is moved (paused too, so the line stays marked where it stopped),
 * with `seek` for an explicit move, and null once the meeting or panel changes; `onPlaying` whether any side is playing.
 */
type PlayerProps = { id: string; tracks: Track[]; openTranscript?: () => void; ref?: Ref<PlayerHandle>; onTime?: (ms: number | null, seek?: boolean) => void; onPlaying?: (on: boolean) => void; onBusy?: (on: boolean) => void }
export function Player(props: PlayerProps) { return props.tracks.length ? <MeetingPlayer key={props.id} {...props} /> : null }
function MeetingPlayer({ id, tracks, openTranscript, ref, onTime, onPlaying, onBusy }: PlayerProps) {
  const [confirm, setConfirm] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleted, setDeleted] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const els = useRef<Partial<Record<Track, HTMLAudioElement>>>({})
  const owned = useRef(new Set<HTMLAudioElement>())
  /** tracks that could not be read: dropped, and the other plays on */
  const [broken, setBroken] = useState<Track[]>([])
  const restoring = useRef(new Set<Track>())
  const pendingPlay = useRef<Want | undefined>(undefined)
  /** the line playing on its own: its side, and where it stops (meeting seconds); null while the whole meeting plays */
  const clip = useRef<{ track: Track; endS: number } | null>(null)
  const clipFrame = useRef(0)
  const shown = tracks.filter((tr) => !broken.includes(tr))
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState(1)
  const onTimeRef = useRef(onTime)
  onTimeRef.current = onTime
  const onPlayingRef = useRef(onPlaying)
  onPlayingRef.current = onPlaying
  const onBusyRef = useRef(onBusy)
  onBusyRef.current = onBusy
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

  /** back to the whole meeting: both sides heard, no stop */
  const endClip = () => {
    clip.current = null
    cancelAnimationFrame(clipFrame.current); clipFrame.current = 0
    for (const a of all()) a.muted = false
  }
  /** a line playing on its own stops at its end; checked every frame (timeupdate alone comes only about 4 times a second) */
  const checkClip = () => {
    const c = clip.current, a = c && els.current[c.track]
    if (!c || !a || a.seeking || a.currentTime < c.endS) return
    pause(); endClip()
  }
  const watchClip = () => {
    clipFrame.current = 0
    if (!clip.current || !anyPlaying()) return
    checkClip()
    if (clip.current) clipFrame.current = requestAnimationFrame(watchClip)
  }
  const go = (w: Want) => {
    if (all().some(a => a.readyState === 0)) { pendingPlay.current = w; return }
    pendingPlay.current = undefined
    endClip()
    if (!w.line) { seek(Math.max(0, w.ms / 1000 - 1)); play(); return }
    const from = Math.max(0, w.ms / 1000 - LINE_LEAD_S)
    seek(from)
    // only their side is heard while it can play the line; without it (gone, unreadable, shorter) everything plays as before
    const own = shown.includes(w.line.track) ? els.current[w.line.track] : undefined
    if (own && from < lenOf(own)) {
      clip.current = { track: w.line.track, endS: w.line.endMs / 1000 + LINE_TAIL_S }
      for (const tr of shown) { const a = els.current[tr]; if (a) a.muted = tr !== w.line.track }
    }
    play()
    if (clip.current) clipFrame.current = requestAnimationFrame(watchClip)
  }
  const playFrom = (ms: number) => go({ ms })
  const playLine = (startMs: number, endMs: number, track: Track) => go(endMs > startMs ? { ms: startMs, line: { endMs, track } } : { ms: startMs })
  useImperativeHandle(ref, () => ({ playFrom, playLine }))
  useEffect(() => { if (pendingPlay.current) go(pendingPlay.current) }, [broken])

  useEffect(() => { for (const a of all()) a.playbackRate = rate }, [rate])
  useEffect(() => { setBroken([]); setPlaying(false); setTime(0); setDuration(0); touched.current = false }, [id])
  // another meeting, or the panel closing: stop
  // React lets go of the elements (els) before this cleanup runs, and an audio let go keeps playing: pause every one it had
  useEffect(() => () => { cancelAnimationFrame(clipFrame.current); clip.current = null; for (const a of owned.current) { a.pause(); a.muted = false } owned.current.clear(); onTimeRef.current?.(null) }, [id])
  useEffect(() => { onPlayingRef.current?.(playing) }, [playing])
  useEffect(() => { onBusyRef.current?.(playing || menuOpen || confirm) }, [playing, menuOpen, confirm])

  const changed = () => setPlaying(anyPlaying())
  const tick = (a: HTMLAudioElement) => {
    // A queued timeupdate can still carry the old clock during a seek. The requested position owns the UI until
    // the media element has settled; otherwise a drag briefly sends the thumb and transcript backwards.
    if (clip.current) checkClip()
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

  const retry = () => {
    restoring.current = new Set(broken)
    setBroken([])
  }
  const rateText = t('{rate}×', { rate: new Intl.NumberFormat(language()).format(rate) })
  const fill = duration ? (time / duration) * 100 : 0
  const note = broken.length === 0 ? null : shown.length === 0 ? t("This recording can't be played.") : t("Part of this recording can't be played.")
  if (deleted) return null
  const more = (
    <Menu.Root modal={false} onOpenChange={setMenuOpen}>
      <Menu.Trigger ref={menuButton} data-testid="recording-menu" aria-label={t('More')} title={t('More')}
        className="ghost-btn workspace-icon ms-auto"><Ellipsis size={17} aria-hidden="true" /></Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="end" sideOffset={6} className="ask-menu-positioner">
          <Menu.Popup className="menu-entry ask-actions-menu player-audio-menu" aria-label={t('More')} finalFocus={confirm ? false : menuButton} onKeyDown={e => { if (e.key === 'Escape') e.stopPropagation() }}>
            <Menu.Item data-testid="recording-delete" className="text-danger" onClick={() => { pause(); menuButton.current?.focus(); setConfirm(true) }}>
              <Trash2 size={14} aria-hidden="true" />{t('Delete audio')}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
  return (
    <div data-testid="player" className="transcript-player text-xs text-muted">
      {shown.map((tr) => (
        <audio key={tr} data-testid={`player-audio-${tr}`} data-track={tr} preload="metadata" src={`yogurt-audio://${id}/${tr}`}
          ref={(a) => { if (a) { els.current[tr] = a; owned.current.add(a) } else delete els.current[tr] }}
          onLoadedMetadata={e => {
            const track = e.currentTarget
            if (restoring.current.delete(tr)) {
              const other = all().find(a => a !== track && !a.paused)
              track.currentTime = Math.min(other?.currentTime ?? time, lenOf(track) || time)
              if (other) start(track)
            }
            setDuration(Math.max(0, ...all().map(lenOf)))
            if (pendingPlay.current) go(pendingPlay.current)
          }}
          onTimeUpdate={(e) => tick(e.currentTarget)}
          onPlay={changed} onPause={changed}
          onEnded={(e) => { if (e.currentTarget === lead()) pause(); changed() }}
          onError={(e) => { failed(tr, e.currentTarget); changed() }} />
      ))}
      {note && <InlineError testId="player-error" className="player-read-error">
        <span data-testid="player-note">{note}</span>
        <div className="inline-error-actions">
          {shown.length === 0 && openTranscript && <a href="#transcript-lines" className="text-action" data-testid="player-open-transcript" onClick={e => { e.preventDefault(); openTranscript() }}>{t('Open in transcript')}</a>}
          <button type="button" className="workspace-button" data-testid="player-retry" onClick={retry}>{t('Try again')}</button>
          {shown.length === 0 && more}
        </div>
      </InlineError>}
      {shown.length > 0 && <div className="flex items-center gap-2">
        <button data-testid="player-toggle" aria-label={playing ? t('Pause') : t('Play')} onClick={() => { if (playing) pause(); else { endClip(); play() } }}
          className="player-btn flex size-[26px] shrink-0 items-center justify-center rounded-full bg-primary text-primary-ink">
          <Swap show={playing ? 'pause' : 'play'} options={{ play: <Play size={13} fill="currentColor" strokeWidth={0} className="ms-0.5" />, pause: <Pause size={13} fill="currentColor" strokeWidth={0} /> }} />
        </button>
        <span className="w-9 shrink-0 text-end tabular-nums">{clock(time * 1000)}</span>
        <input data-testid="player-scrubber" type="range" min={0} max={duration || 0} step={0.1} value={Math.min(time, duration || 0)} aria-label={t('Position')}
          onChange={(e) => { endClip(); seek(Number(e.target.value)) }} className="scrubber min-w-0 flex-1" style={{ ['--fill' as string]: `${fill}%` }} />
        <span className="w-9 shrink-0 tabular-nums">{clock(duration * 1000)}</span>
        <button data-testid="player-speed" aria-label={t('Playback speed {rate}', { rate: rateText })}
          onClick={() => setRate((r) => RATES[(RATES.indexOf(r) + 1) % RATES.length])}
          className="ghost-btn tabular-nums">
          {rateText}
        </button>
        {more}
      </div>}
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
  return <Modal testId="recording-delete-confirm" role="alertdialog" title={t('Delete audio?')}
    description={t('The audio is deleted for good. Your transcript and notes stay.')} busy={busy} onCancel={onCancel}>
    {failed && <InlineError testId="recording-delete-failed" className="inline-error-in-dialog"><span>{failed === 'not-transcribed' ? t('Keep the audio until the transcript is saved.')
      : failed === 'recording' ? t('Stop the recording first, then try again.') : t("Yogurt couldn't delete the audio.")}</span></InlineError>}
    <div className="modal-actions">
      <button data-testid="recording-delete-yes" className="modal-button danger" disabled={busy} onClick={() => void yes()}>{t('Delete audio')}</button>
      <ModalClose data-testid="recording-delete-cancel" data-dialog-cancel className="workspace-button" disabled={busy}>{t('Cancel')}</ModalClose>
    </div>
  </Modal>
}
