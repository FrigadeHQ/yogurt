import { transcriptKey as key } from '../../../shared/transcriptFind'
import type { RemovedSpan, CommitTranscript, TranscriptHistory, TranscriptDifference } from '../../../shared/transcriptEdit'
import { keys, command } from '../keys'
import { TranscriptChanges } from './TranscriptChanges'
import { TranscriptDocument, type DocumentControls } from './TranscriptDocument'
import { InlineError, ReadError } from './InlineError'
import { TranscriptionNotice, type TranscriptNotice } from './Transcription'
import {transcriptReplacement} from '../../../shared/transcriptReplacement'
import { citationTargetIndex } from '../../../shared/citations'
import { SPEAKER_COLORS } from '../../../shared/speakerColors'
import { ScrollFade } from './ScrollFade'
import { Loading } from './Loading'
import { useLoadingState } from '../useLoadingState'
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { AudioLines, ArrowDown, ArrowTurnBackward, ArrowTurnForward } from './Icons'
import type { Segment, TranscriptPartial } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { useLanguage } from '../i18n'
import { transcriptRowKey, transcriptSpeaker, bubbles, clock, echoRuns, lineAt, playbackLookup, recentRuns, stableKeys, turns, withLive, type LiveSaid } from '../../../shared/transcript'
import { TranscriptFind } from './TranscriptFind'
import { Player, type PlayerHandle } from './Player'
import { attachPlayerVisibility } from '../playerVisibility'
import { rememberedScroll, useScrollMemory } from '../useScrollMemory'
import { followGlide, scrollBehavior } from '../motion'
import { followTarget, inView } from '../../../shared/follow'
import { afterFinal, joinWords } from '../../../shared/liveWords'

type Line = Omit<Segment, 'id'> & { id?: number; previous?:boolean }
const moment = (l: { track: string; startMs: number }) => `${l.track}:${l.startMs}`
/** this close to the bottom still counts as reading the latest lines */
const STICK_PX = 24
/** after their own scroll, playing waits this long before it moves the list, so it never takes over mid-gesture */
const HANDS_OFF_MS = 400

/** You on the mic; on the other side the name the call app showed talking, Them when it showed none */
const who = transcriptSpeaker

/** The lines of a meeting, live while it records; `live` holds the lines that arrived while watching */
function useLines(id: string,replacing:boolean, settled: boolean) {
  const [snapshot,setSnapshot] = useState<{ revision: number; removed: RemovedSpan[]; edits:TranscriptDifference[]; history:TranscriptHistory; editable: boolean }>()

  const [draft,setDraft]=useState<Line[]>([])
  const draftRef=useRef<Line[]>([])
  draftRef.current=draft
  useEffect(()=>{
    let active=true,revision=0
    setDraft([])
    if(!replacing)return
    const load=()=>{const request=++revision;void window.yogurt.transcript.draft(id).then(lines=>{
      if(!active||request!==revision)return
      for(const line of lines)live.current.add(key(line))
      setDraft(lines)
    }).catch(console.error)}
    const off=window.yogurt.transcript.onDraft(changed=>{if(changed===id)load()})
    load();return()=>{active=false;off()}
  },[id,replacing])
  const [lines, setLines] = useState<Line[]>([])
  const [failed, setFailed] = useState(false)
  const retry = useRef<() => void>(() => {})
  const [loaded, setLoaded] = useState(false)
  const live = useRef(new Set<string>())
  useEffect(() => {
    let active = true,epoch=0
    setSnapshot(undefined); setFailed(false); setLoaded(false); setLines([]); live.current = new Set()
    const add = (more: Line[], arriving: boolean) => setLines((cur) => {
      const seen = new Set(cur.map(key))
      const savedMoments = new Set(cur.filter(l => l.id !== undefined).map(moment))
      const fresh = more.filter(l => l.meetingId === id && !seen.has(key(l)) && (l.id !== undefined || !savedMoments.has(moment(l))))
      if (arriving) for (const l of fresh) live.current.add(key(l))
      return fresh.length ? [...cur, ...fresh].sort((a, b) => a.startMs - b.startMs) : cur
    })
    const off = window.yogurt.transcript.onSegment((l) => add([l], true))
    const load = (replace = false) => {
      const request = ++epoch
      retry.current = () => load(replace)
      const read = settled ? window.yogurt.transcript.snapshot(id).then(state => {
        if (active && request === epoch) setSnapshot({ revision: state.revision, removed: state.removed, edits:state.changes, history:{canUndo:state.canUndo,canRedo:state.canRedo}, editable: state.editable })
        return state.lines
      }) : window.yogurt.transcript.get(id, { hidden: true })
      void read.then(saved => {
        if (!active || request !== epoch) return
        setFailed(false); setLoaded(true)
        if (replace || settled) setLines(saved)
        else setLines(cur => {
          const fresh = new Map(saved.map(l => [key(l), l]))
          const moments = new Set(saved.map(moment))
          cur = cur.filter(l => l.id !== undefined || !moments.has(moment(l)))
          const have = new Set(cur.map(key))
          return [...cur.map(l => fresh.get(key(l)) ?? l), ...saved.filter(l => !have.has(key(l)))].sort((a, b) => a.startMs - b.startMs)
        })
      }, () => { if (active && request === epoch) setFailed(true) })
    }
    load()
    const offSpeakers = window.yogurt.transcript.onSpeakers(m => { if (m === id) load() })
    const offReplaced = window.yogurt.transcript.onReplaced?.(changed => {
      if (changed !== id) return
      if (draftRef.current.length) setLines(draftRef.current)
      load(true)
    })
    return () => { active = false; off(); offSpeakers();offReplaced?.() }
  }, [id,settled])
  return { lines, draft, live, loaded, failed, retry, snapshot }
}

/**
 * What each side is saying right now, not final yet: one reading per track, replaced as it grows. A final line that
 * arrives takes its own words off at once (shared/liveWords), in the same render that shows it, so nothing shows twice.
 * `previewed` tells a final line that took the place of live words (it settles in place instead of fading in).
 */
/** a recording draws this many of its latest lines, trimmed in steps of LIVE_STEP (recentRuns) */
const LIVE_LINES = 300
const LIVE_STEP = 50

function useLive(id: string, recording: boolean) {
  const [parts, setParts] = useState<Partial<Record<'me' | 'them', LiveSaid>>>({})
  /** how far each side's live words have reached */
  const seen = useRef<Record<'me' | 'them', number>>({ me: -Infinity, them: -Infinity })
  useEffect(() => {
    setParts({}); seen.current = { me: -Infinity, them: -Infinity }
    if (!recording) return
    const offPartial = window.yogurt.transcript.onPartial((p) => {
      if (p.meetingId !== id) return
      const words = p.words ?? []
      if (words.length) seen.current[p.track] = Math.max(seen.current[p.track], words.at(-1)!.endMs)
      setParts((cur) => ({ ...cur, [p.track]: { track: p.track, startMs: words[0]?.startMs ?? p.startMs, endMs: words.at(-1)?.endMs ?? p.startMs, text: p.text, words } }))
    })
    const offSegment = window.yogurt.transcript.onSegment((l) => {
      if (l.meetingId !== id) return
      setParts((cur) => {
        const had = cur[l.track]
        if (!had) return cur
        const words = afterFinal(had.words, { endMs: l.endMs, text: l.text })
        return { ...cur, [l.track]: { ...had, words, text: joinWords(words), startMs: words[0]?.startMs ?? had.startMs } }
      })
    })
    return () => { offPartial(); offSegment() }
  }, [id, recording])
  const previewed = useCallback((l: { track: 'me' | 'them'; startMs: number }) => l.startMs < seen.current[l.track] + 500, [])
  return { live: (['me', 'them'] as const).map((t) => parts[t]).filter((x): x is LiveSaid => !!x && x.words.length > 0), previewed }
}

/**
 * Live words as they come: lighter than final text, each new word fading in where it lands; a word read again
 * differently changes in place. Three soft dots after them say more is coming.
 */
export function LiveWords({ said }: { said: LiveSaid }) {
  const keys = useRef<{ words: string[]; keys: number[]; next: number }>({ words: [], keys: [], next: 0 })
  const texts = said.words.map((w) => w.text)
  const k = stableKeys(keys.current.words, keys.current.keys, texts, keys.current.next)
  keys.current = { words: texts, keys: k.keys, next: k.next }
  return (
    <span data-testid="transcript-partial" data-track={said.track} data-start={said.startMs} aria-live="off" className="live-words">
      {said.words.map((w, i) => <span key={k.keys[i]} className="live-word">{i === 0 || w.glue ? w.text : ` ${w.text}`}</span>)}
      <span className="live-dots" aria-hidden="true"><i /><i /><i /></span>
    </span>
  )
}

type RowProps = {
  line: Line
  /** the line an answer across meetings pointed to */
  focused?: boolean
  name: string
  playing: boolean; playable: boolean; settled: boolean; focusable: boolean
  /** arrived while watching: fades in, or settles in place where live words stood for it */
  arrived: 'fade' | 'settle' | null
  onPlay: (l: Line) => void; onFocusLine: (k: string) => void
}
/**
 * One line of the transcript, a stretch of text in its bubble (who said it heads the turn). Drawn again only when what
 * it shows changes (a long meeting has thousands).
 */
const Row = memo(function Row({ line: l, focused, name, playing, playable, settled, focusable, arrived, onPlay, onFocusLine }: RowProps) {
  // memo skips it otherwise when the language changes
  useLanguage()
  if (window.yogurt.fake) (window as unknown as { __rowRenders?: number }).__rowRenders = ((window as unknown as { __rowRenders?: number }).__rowRenders ?? 0) + 1
  const k = key(l), time = clock(l.startMs)
  return (
    <span data-key={k} data-testid="transcript-line" data-track={l.track} data-start={l.startMs} data-playing={playing || undefined}
      role={settled || playable ? 'group' : undefined} aria-label={settled || playable ? name : undefined}
      tabIndex={playable ? (focusable ? 0 : -1) : undefined} onFocus={() => onFocusLine(k)}
      data-corrected={l.corrected || undefined} data-previous={l.previous || undefined} data-hidden={l.hidden || undefined} data-focused={focused || undefined}
      className={`line ${arrived === 'fade' ? 'line-in' : arrived === 'settle' ? 'line-settle' : ''}`}>
      {playable && <button type="button" data-testid="transcript-time" className="transcript-line-time" tabIndex={focusable ? 0 : -1} aria-label={t('Play from {time}', { time })} onClick={() => onPlay(l)}>{time}</button>}
      {settled && !playable && <time data-testid="transcript-time" className="transcript-line-time">{time}</time>}
      <span data-testid="transcript-text">{l.text}</span>
      {!settled && !playable && <time data-testid="transcript-time" className="sr-only">{time}</time>}
    </span>
  )
})

/**
 * The meeting's transcript: each turn carries who said it, following new lines
 * while it records; after the meeting the timestamp plays from that moment, and the player sits at the bottom. The header searches it.
 */
export function Transcript({ id, settled = false, notice, processing=false, replacing=false, recording, inline = false, active = true, onClose, focus, toolbar }: {
  id: string; settled?: boolean; notice?: TranscriptNotice; processing?:boolean; replacing?:boolean; recording: boolean; inline?: boolean; active?: boolean; toolbar?: HTMLElement | null; onClose?: () => void
  /** a line to show and mark (an answer's source): ms into the meeting; seq: each time it is asked for */
  focus?: { ms: number; match?: string; verifiedRow?: number; revision?: number; seq: number }
}) {
  const { lines:latest, draft, live, loaded, failed, retry, snapshot } = useLines(id,replacing,settled)
  const [editing, setEditing] = useState(false)
  const editUnavailable = recording ? t('Available after recording') : processing || notice?.kind==='transcribe' ? t('Finish transcription to edit lines.') : undefined
  const canEdit = settled && snapshot?.editable && !editUnavailable
  const editMode = !!canEdit && editing
  const editor = useRef<DocumentControls | null>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  useEffect(()=>{setEditing(false)},[id,canEdit])
  const leave = () => {
    setEditing(false)
    requestAnimationFrame(()=>editButton.current?.focus({preventScroll:true}))
  }
  const commit = useCallback<CommitTranscript>((revision,change)=>window.yogurt.transcript.change(id,revision,change),[id])
  const allLines=useMemo(()=>replacing?transcriptReplacement(latest,draft):latest,[latest,draft,replacing])
  const loadingPhase = useLoadingState(!loaded && !failed)
  const { live: liveSaid, previewed } = useLive(id, recording)
  // the mic's copy of the call (hidden as an echo) never shows
  const timeline = useMemo(() => echoRuns(withLive(allLines, liveSaid)).filter(run => !run.echo), [allLines, liveSaid])
  const lines = useMemo(() => echoRuns(allLines).filter(run => !run.echo).flatMap(run => run.lines), [allLines])
  const editLines = useMemo(()=>editMode ? lines.filter((l):l is Segment=>l.id!==undefined && l.id>0) : [],[editMode,lines])
  const [finding, setFinding] = useState(false)
  // a long recording draws its latest lines; the earlier ones on request (recentRuns)
  const [showAll, setShowAll] = useState(false)
  useEffect(() => { setFinding(false); setShowAll(false) }, [id])

  // the recording is only playable once it is finished
  const [tracks, setTracks] = useState<Array<'me' | 'them'>>([])
  useEffect(() => {
    setTracks([])
    if (recording || processing) return
    let on = true
    let deleted = false
    const off = window.yogurt.audio.onDeleted(changed => {
      if (changed !== id) return
      if (document.activeElement?.closest('[data-testid="player"], [data-testid="recording-delete-confirm"]')) {
        list.current?.setAttribute('tabindex', '-1'); list.current?.focus({ preventScroll: true })
      }
      deleted = true; setTracks([]); setAudioOn(false); onTime(null)
    })
    const load=()=>void window.yogurt.audio.tracks(id).then(t=>{if(on&&!deleted)setTracks(t)}).catch(console.error)
    load();const offMeeting=window.yogurt.meetings.onChange(load)
    return () => { on = false; off(); offMeeting() }
  }, [id, recording, processing])
  const player = useRef<PlayerHandle>(null)
  const playable = !processing && tracks.length > 0
  const playbackDock = useRef<HTMLDivElement>(null)
  const [playbackInset, setPlaybackInset] = useState(0)
  const visibility = useRef<ReturnType<typeof attachPlayerVisibility> | null>(null)
  useLayoutEffect(() => {
    const dock = playbackDock.current
    if (!dock) { setPlaybackInset(0); return }
    // Reserve the actual controls height, including playback errors and larger text.
    const measure = () => setPlaybackInset(dock.getBoundingClientRect().height + 28)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(dock)
    return () => observer.disconnect()
  }, [playable, active])

  // the line being played: found by a binary search on each tick, drawn only when it changes
  const [shownKey, setShownKey] = useState<string>()
  const [seek, setSeek] = useState(0)
  const followedSeek = useRef(0)
  const lookup = useMemo(() => playbackLookup(lines,snapshot?.removed ?? []),[lines,snapshot?.removed])
  const lookupRef = useRef(lookup)
  lookupRef.current = lookup
  const linesRef = useRef(lines)
  linesRef.current = lines
  const playhead = useRef<number|null>(null)
  const onTime = useCallback((ms: number | null, seeking = false) => {
    playhead.current = ms
    const i = ms == null ? -1 : lookupRef.current(ms)
    const k = i < 0 ? undefined : key(linesRef.current[i])
    setShownKey((cur) => (cur === k ? cur : k))
    if (seeking) setSeek((n) => n + 1)
  }, [])

  useEffect(() => { if (playhead.current !== null) onTime(playhead.current) },[lookup,onTime])

  // follow the newest line while recording, unless they scrolled up to read
  const scrollKey = `transcript/${id}`
  const list = useScrollMemory<HTMLOListElement>(scrollKey, active && loaded)
  useLayoutEffect(() => {
    const el = list.current, dock = playbackDock.current
    if (!active || !playable || !el || !dock) return
    const controls = attachPlayerVisibility(el, dock)
    visibility.current = controls
    return () => { controls.dispose(); visibility.current = null }
  }, [id, active, playable])
  const replacementFollow=useRef(true)
  useLayoutEffect(()=>{if(replacing){replacementFollow.current=true;if(list.current)list.current.scrollTop=0}},[id,replacing])
  useLayoutEffect(()=>{
    if(!replacing||!processing||!active||finding||!replacementFollow.current||!draft.length)return
    const line=[...draft].sort((a,b)=>a.startMs-b.startMs).at(-1)!
    const row=list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key(line))}"]`)
    row?.scrollIntoView({block:'nearest'})
  },[draft,replacing,processing,active,finding])
  const stick = useRef(rememberedScroll(scrollKey) === undefined)
  const [behind, setBehind] = useState(false)
  const onScroll = () => {
    const el = list.current
    if (!el) return
    // not Yogurt's own glide, so theirs (the scroll bar dragged, a trackpad's glide): playing keeps its hands off while it lasts
    if (ours.current === null) { handsOn.current = performance.now(); theyScrolled() }
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
    setBehind(!stick.current)
  }
  useLayoutEffect(() => {
    const el = list.current
    if (active && recording && !finding && el && stick.current) { visibility.current?.programmatic(); el.scrollTop = el.scrollHeight }
  }, [lines, liveSaid, recording, active, finding])
  const toLatest = () => { const el = list.current; if (el) { visibility.current?.programmatic(); stick.current = true; setBehind(false); el.scrollTo({ top: el.scrollHeight, behavior: scrollBehavior() }) } }

  // playing follows along: the line being played kept comfortably in view, until they scroll it out of sight
  const rowOf = (k?: string) => (k ? list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(k)}"]`) ?? null : null)
  const [audioOn, setAudioOn] = useState(false)
  const following = useRef(true)
  /** where the line being played went while they looked elsewhere, for Back to playing */
  const [away, setAway] = useState<'up' | 'down' | null>(null)
  /** stops Yogurt's own glide while it moves; its scroll events are not taken for theirs */
  const ours = useRef<ReturnType<typeof followGlide> | null>(null)
  /** when they last turned the wheel, pressed a key or touched the list: a glide started then would swallow their scroll */
  const handsOn = useRef(0)
  const shownKeyRef = useRef(shownKey)
  shownKeyRef.current = shownKey
  useEffect(() => { following.current = true; setAway(null) }, [id])
  /** the row's place in the list's content and the list's scroll */
  const measure = (row: HTMLElement) => {
    const el = list.current!, box = el.getBoundingClientRect(), r = row.getBoundingClientRect()
    const top = r.top - box.top + el.scrollTop
    return { row: { top, bottom: top + r.height }, view: { scrollTop: el.scrollTop, height: Math.max(0, el.clientHeight - playbackInset), scrollHeight: el.scrollHeight } }
  }
  const showPlaying = (always: boolean) => {
    const el = list.current, row = rowOf(shownKeyRef.current)
    if (finding || !el || !row || (!always && performance.now() - handsOn.current < HANDS_OFF_MS)) return
    const { row: r, view } = measure(row)
    const to = followTarget(r, view, always)
    if (to === null || !ours.current && Math.abs(to - el.scrollTop) < 2) return
    if (!ours.current) {
      // The final scroll event arrives after done. A fresh seek in that frame still belongs to Yogurt.
      const motion = followGlide(el, () => requestAnimationFrame(() => {
        if (ours.current === motion && !motion.active) ours.current = null
      }))
      ours.current = motion
    }
    visibility.current?.programmatic()
    ours.current.to(to)
  }
  // An explicit seek asks to follow again, even paused or within the same line. Ordinary ticks respect reading elsewhere.
  useEffect(() => {
    if (seek !== followedSeek.current) {
      followedSeek.current = seek
      following.current = true; setAway(null)
      showPlaying(true)
    } else if (audioOn && following.current) showPlaying(false)
  }, [shownKey, audioOn, seek])
  const follow = useCallback(() => { following.current = true; setAway(null) }, [])
  const backToPlaying = () => { follow(); showPlaying(true) }
  /** a scroll of theirs: following goes on while the line being played still shows, and stops once it is out of sight */
  const theyScrolled = () => {
    const el = list.current, row = rowOf(shownKeyRef.current)
    if (recording || !el || !row) return
    const { row: r, view } = measure(row)
    following.current = inView(r, view)
    setAway(following.current ? null : r.top < view.scrollTop ? 'up' : 'down')
  }
  // a wheel, a key, a touch or a press (the scroll bar too): a glide of Yogurt's still moving is stopped, so it can't carry them back
  const theirs = () => {
    replacementFollow.current=false
    handsOn.current = performance.now()
    ours.current?.stop()
    ours.current = null
  }
  useEffect(() => () => { ours.current?.stop(); ours.current = null }, [id, active])

  const onPlay = useCallback((l: Line) => {
    follow()
    player.current?.playFrom(l.startMs)
  }, [follow])

  // the line an answer pointed to: in the middle of the panel, marked, and the list's tab stop
  const [focusedKey, setFocusedKey] = useState<string>()
  const focusDone = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!active || !focus || focusDone.current === focus.seq || !lines.length) return
    const visible = lines.filter(line => !line.hidden)
    const match = focus.match ? visible[citationTargetIndex(visible.map(line => line.text), focus.match, Math.max(0, lineAt(visible, focus.ms)))] : undefined
    const l = focus.verifiedRow === undefined ? match ?? lines[Math.max(0, lineAt(lines, focus.ms))]
      : snapshot && (focus.revision ?? 0) === snapshot.revision ? visible.find(l=>l.id === focus.verifiedRow) : undefined
    if (!l) return
    focusDone.current = focus.seq
    stick.current = false
    setShowAll(true)
    setFocusedKey(focus.match&&!match?undefined:key(l)); setFocusKey(key(l))
    requestAnimationFrame(() => { visibility.current?.programmatic(); rowOf(key(l))?.scrollIntoView({ block: 'center' }) })
  }, [focus?.seq, lines, active, snapshot?.revision])
  useEffect(() => {
    if (!focusedKey) return
    const timer = window.setTimeout(() => setFocusedKey(undefined), 2400)
    return () => clearTimeout(timer)
  }, [focusedKey, focus?.seq])
  // one tab stop for the whole list (the line last focused, or playing, or the first); arrows move between lines
  const [focusKey, setFocusKey] = useState<string>()
  const tabKey = focusKey && lines.some(l=>key(l)===focusKey) ? focusKey : shownKey ?? (lines[0] && key(lines[0]))
  const onKeyDown = (e: KeyboardEvent<HTMLOListElement>) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-testid="transcript-line"]')
    if (!playable || editMode || !row || row !== e.target) return
    const i = lines.findIndex((l) => key(l) === row.dataset.key)
    if (i < 0) return
    const go = (j: number) => { const next = rowOf(key(lines[Math.max(0, Math.min(lines.length - 1, j))])); visibility.current?.programmatic(); next?.focus({ preventScroll: true }); next?.scrollIntoView({ block: 'nearest' }) }
    if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); go(i - 1) }
    else if (e.key === 'Home') { e.preventDefault(); go(0) }
    else if (e.key === 'End') { e.preventDefault(); go(lines.length - 1) }
  }

  const grouped = useMemo(() => timeline.map((run, i) => ({ ...run, k: key(run.lines[0]), rowKey: transcriptRowKey(run.lines[0].track, timeline[i - 1]?.lines.at(-1)) })), [timeline])
  const drawn = useMemo(() => (recording && !showAll ? recentRuns(grouped, LIVE_LINES, LIVE_STEP) : { runs: grouped, earlier: 0 }), [grouped, recording, showAll])
  const find = useCallback((open: boolean) => {
    setFinding(open)
    if (open) { setShowAll(true); stick.current = false; ours.current?.stop(); ours.current = null }
  }, [])
  const empty = loaded && !failed && timeline.length === 0 && (!processing || !!notice)
  const noticeContent = notice && <TranscriptionNotice notice={notice} centered={empty} hasLines={timeline.length > 0} />
  const [changed,setChanged] = useState(false)
  const [showChanges,setShowChanges] = useState(false)
  useEffect(()=>{ if (!editMode) { setShowChanges(false); setChanged(false) } },[editMode])
  const reviewing = editMode && showChanges && !!snapshot?.edits.length
  useEffect(()=>{ if (!snapshot?.edits.length && !changed) setShowChanges(false) },[snapshot?.edits.length,changed])
  const finish = async () => { if (await editor.current?.finish()) leave() }
  const shortcut = keys('⌘⌥E')
  useEffect(()=>{
    if (!active || !canEdit || (!lines.length && !snapshot?.edits.length)) return
    const toggle = (e:globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.isComposing || e.shiftKey || !e.altKey || !command(e) || e.code!=='KeyE' ||
        document.querySelector('dialog:modal,[aria-modal="true"]')) return
      e.preventDefault()
      if (editMode) void finish()
      else setEditing(true)
    }
    window.addEventListener('keydown',toggle)
    return ()=>window.removeEventListener('keydown',toggle)
  },[active,canEdit,editMode,lines.length,snapshot?.edits.length])
  const Surface = inline ? 'section' : 'aside'

  return (
    <Surface style={{ '--playback-inset': `${playbackInset}px` } as CSSProperties} data-testid="transcript-panel" aria-label={t('Transcript')} onKeyDown={e=>{
        if (e.defaultPrevented || e.nativeEvent.isComposing) return
        if (e.key==='Escape' && editMode) { e.preventDefault(); e.stopPropagation(); void finish() }
        else if (editMode && !e.altKey && (e.metaKey || e.ctrlKey) && e.key.toLowerCase()==='z') { e.preventDefault(); void editor.current?.step(e.shiftKey ? 'redo' : 'undo') }
        else if (!inline && e.key==='Escape') { e.stopPropagation(); onClose?.() }
      }}
      className={inline ? 'transcript-inline' : 'chat-in pointer-events-auto absolute inset-x-0 bottom-1 z-20 mx-auto flex h-[min(44vh,480px)] w-[min(720px,calc(100%-48px))] flex-col rounded-xl border border-line bg-float shadow-[var(--shadow)]'}>
      <TranscriptFind extra={!editMode && (editUnavailable || (canEdit && (lines.length>0 || snapshot?.edits.length))) ?
        <button ref={editButton} className="ghost-btn transcript-tool" data-testid="transcript-edit" disabled={!!editUnavailable}
          title={editUnavailable ?? t('Edit')+' ('+shortcut+')'} aria-description={editUnavailable} aria-keyshortcuts="Meta+Alt+E Control+Alt+E"
          onClick={()=>setEditing(true)}>{t('Edit')}</button> : undefined} key={id} lines={lines} list={list} active={active} playbackInset={playbackInset} beforeScroll={() => visibility.current?.programmatic()} onFinding={find} toolbar={toolbar} onClose={!inline ? onClose : undefined} />
      <div className="transcript-scroll-wrap relative flex min-h-0 flex-1 flex-col">
        <ScrollFade enabled={active && loaded}><ol id="transcript-lines" data-loaded={loaded} data-loading-phase={loadingPhase} data-testid="transcript" data-replacing={replacing&&processing} ref={list} onScroll={onScroll} onWheel={theirs} onTouchStart={theirs} onPointerDown={theirs} onKeyDownCapture={theirs} onKeyDown={onKeyDown} className="loading-content transcript-loading-content flex flex-1 flex-col gap-2 overflow-y-auto px-4 pb-4 pt-2 text-sm leading-[1.55]">
          {editMode && <li className="transcript-tools-slot">
            <div className="transcript-edit-tools" role="group" aria-label={t('Edit transcript')}>
              <button className="ghost-btn workspace-icon" disabled={!changed && !snapshot!.history.canUndo} aria-label={t('Undo')} title={t('Undo')} onClick={()=>void editor.current?.step('undo')}><ArrowTurnBackward size={15}/></button>
              <button className="ghost-btn workspace-icon" disabled={changed || !snapshot!.history.canRedo} aria-label={t('Redo')} title={t('Redo')} onClick={()=>void editor.current?.step('redo')}><ArrowTurnForward size={15}/></button>
              <button className="ghost-btn transcript-done" title={t('Done')+' ('+shortcut+')'} data-testid="transcript-done" onClick={()=>void finish()}>{t('Done')}</button>
              {(changed || snapshot!.edits.length>0) && <>
                <button className="ghost-btn" onClick={()=>void editor.current?.revert(null)}>{t('Revert all')}</button>
                <button className="ghost-btn" aria-expanded={reviewing} onClick={async()=>{if(await editor.current?.finish()) setShowChanges(!showChanges)}}>{t('Changes')}</button>
              </>}
            </div>
          </li>}
          {editMode && <li>
            <TranscriptDocument key={id} id={id} reviewing={reviewing} saved={{revision:snapshot!.revision,lines:editLines}}
              commit={commit} controls={editor} leave={leave} onDirty={setChanged} />
            {reviewing && <TranscriptChanges changes={snapshot!.edits} restore={(id,removed)=>void editor.current?.revert(id,removed)}/>}
          </li>}
          {!empty && noticeContent && <li className="transcription-notice-slot">{noticeContent}</li>}
          {processing&&!notice&&!replacing&&timeline.length===0&&<li className="transcription-placeholder" aria-hidden="true"><p className="turn-head"><span className="loading-bar" style={{width:42}}/></p><p className="bubble bubble-them"><span className="loading-bar" style={{width:180}}/></p></li>}
          {failed && (timeline.length || processing || playable || notice ? <li><InlineError testId="transcript-read-error" retry={() => retry.current()} /></li>
            : <li className="flex flex-1"><ReadError testId="transcript-read-error" retry={() => retry.current()} /></li>)}
          {!failed && loadingPhase !== 'ready' && timeline.length===0 && <li className="loading-placeholder"><Loading layout="transcript" /></li>}
          {empty && !reviewing && <li data-testid="transcript-empty" className="note-empty empty-state">
            <div className="empty-state-content">
              <div className="empty-tile"><AudioLines size={28} aria-hidden="true" /></div>
              {snapshot?.removed.length ? t('All transcript lines have been removed.') : noticeContent ?? t('Nothing heard yet.')}
            </div>
          </li>}
          {drawn.earlier > 0 && <li className="flex justify-center"><button data-testid="transcript-earlier" onClick={() => { visibility.current?.programmatic(); stick.current = false; setShowAll(true) }} className="ghost-btn">{t('Show earlier lines')}</button></li>}
          {!editMode && drawn.runs.map(run => <Fragment key={run.rowKey}>
            {turns(run.lines).map((turn, i, groups) => {
            const me = turn[0].track === 'me', first = turn[0]
            const color = me || !('speakerColor' in first) ? undefined : first.speakerColor
            // a name comes with the first final line; until then its place is kept, so nothing moves when it shows
            const named = turn.some((x) => !('live' in x))
            return (
              <li key={transcriptRowKey(first.track, groups[i - 1]?.at(-1))} data-testid="transcript-turn" data-track={first.track} className={`transcript-turn flex flex-col gap-[5px] ${me ? 'items-end' : 'items-start'}`}>
                {/* the other side's name heads their turn; the mic's side needs none, its bubbles sit at the end */}
                <p className={me ? 'sr-only' : 'turn-head flex items-baseline gap-2 px-1 text-xs'}>
                  <span data-testid="transcript-who" data-color={color} data-folder-color={color === undefined ? undefined : SPEAKER_COLORS[color]} className={`line-who font-medium ${me ? '' : 'text-muted'} ${named ? 'name-in' : 'invisible'}`}>{who(first)}</span>
                  <time className="turn-time tabular-nums text-muted">{clock(first.startMs)}</time>
                </p>
                {bubbles(turn).map((b, i, groups) => (
                  <p key={transcriptRowKey(first.track, groups[i - 1]?.at(-1))} data-testid="transcript-bubble" data-track={first.track} dir="auto" className={`bubble ${me ? 'bubble-me' : 'bubble-them'}`}>
                    {b.map((x, i) => {
                      if ('live' in x) return <Fragment key="live">{i > 0 && ' '}<LiveWords said={x.live} /></Fragment>
                      const k = key(x)
                      return (
                        <Fragment key={k}>{i > 0 && ' '}
                          <Row line={x} focused={k === focusedKey} name={who(x)}
                            playing={k === shownKey} playable={playable} settled={settled} focusable={k === tabKey} arrived={!x.previous&&live.current.has(k) ? (previewed(x) ? 'settle' : 'fade') : null} onPlay={onPlay} onFocusLine={setFocusKey} />
                        </Fragment>
                      )
                    })}
                  </p>
                ))}
              </li>
            )
          })}</Fragment>)}
        </ol></ScrollFade>
        {recording && behind && !finding && (
          <button data-testid="transcript-latest" onClick={toLatest} className="workspace-button absolute bottom-3 start-1/2 -translate-x-1/2 rtl:translate-x-1/2">
            <ArrowDown size={12} aria-hidden="true" />{t('Latest')}
          </button>
        )}
        {!recording && audioOn && away && shownKey && !finding && (
          <button data-testid="transcript-follow" onClick={backToPlaying} className="workspace-button absolute bottom-3 start-1/2 -translate-x-1/2 rtl:translate-x-1/2">
            <ArrowDown size={12} aria-hidden="true" className="follow-arrow" data-up={away === 'up'} />{t('Back to playing')}
          </button>
        )}
      </div>
      {active && playable && <div ref={playbackDock} className="transcript-player-dock"><Player ref={player} id={id} tracks={tracks} openTranscript={drawn.runs.length ? () => {
        const row = rowOf(drawn.runs[0].k)
        visibility.current?.programmatic()
        row?.focus({ preventScroll: true })
        row?.scrollIntoView({ block: 'center' })
      } : undefined} onTime={onTime} onPlaying={setAudioOn} onBusy={on => visibility.current?.pin(on)} /></div>}
    </Surface>
  )
}
