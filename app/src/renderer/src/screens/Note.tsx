import { InlineError, ReadError } from '../components/InlineError'
import { TranscriptionControl, TranscriptionNotice } from '../components/Transcription'
import { transcriptionBusy } from '../../../shared/transcription'
import { citationTargetIndex } from '../../../shared/citations'
import { NoteReadingPane } from '../components/NoteReadingPane'
import type { LibrarySource } from '../../../shared/types'
import { flushSync } from 'react-dom'
import { Loading } from '../components/Loading'
import { LoadingContent } from '../components/LoadingContent'
import { motion, useReducedMotion } from '../motion'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useScrollMemory } from '../useScrollMemory'
import { Lock, RotateCcw, Trash2 } from 'lucide-react'
import type { MeetingView, NoteSaveResult, NoteSide, NoteView, SetupState, WidgetView } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { osWords } from '../keys'
import { Modal, ModalClose } from '../components/Modal'
import { NotesModelWait } from '../components/NotesModelWait'
import { SummaryWaiting } from '../components/SummaryWaiting'
import { Editor } from '../components/Editor'
import { mergeNoteView } from '../noteMerge'
import { Transcript } from '../components/Transcript'
import { Ask } from '../components/Chat'
import { LevelBars } from '../components/LevelBars'
import { RecordingTime } from '../components/RecordingTime'
import { RecordingAction } from '../components/RecordingAction'
import { Mic, Pause, Play } from '../components/Icons'
import { ShareMenu } from '../components/ShareMenu'
import { NoteMenu, summaryAction } from '../components/NoteMenu'
import { DeleteNote } from '../components/DeleteNote'
import { openAudioUpload } from '../components/AudioUpload'
import { moveToTrash, toasts } from '../components/TrashToast'
import { useSummaryPresentation } from '../summaryPresentation'
import { useSmoothText } from '../useSmoothText'
import { NoteAutosave, registerAutosave } from '../noteAutosave'
import { People } from '../components/People'
import { NoteDate } from '../components/NoteDate'
import { MicMenu } from '../components/MicMenu'
import { SpokenMenu } from '../components/SpokenMenu'
import { RecordingHint } from '../components/RecordingHint'
import { FolderChip, FolderPicker, type FolderSuggestion } from '../components/FolderPicker'
import { FolderName } from '../components/FolderDialogs'
import { Swap, SwapText } from '../components/Swap'

const RECORDING_CONTROL_TREATMENT: 'neutral-icons' | 'accent-icons' | 'word' = 'neutral-icons'

/** A revision is dirty until main acknowledges it; failed text also remains there across navigation/reload. */
function useAutosave(id: string, side: NoteSide, text: string, saved?: NoteSaveResult) {
  const [, redraw] = useState(0)
  const saver = useMemo(() => new NoteAutosave(
    (edit) => side === 'mine' ? window.yogurt.notes.setMine(id, edit.text, edit.revision) : window.yogurt.notes.setEnhanced(id, edit.text, edit.revision),
    (edit) => window.yogurt.notes.flushSync(id, side, edit.text, edit.revision),
  ), [id, side])
  saver.seed(text, saved)
  useEffect(() => { saver.changed = () => redraw((n) => n + 1); return registerAutosave(saver) }, [saver])
  return { change: (md: string) => saver.change(md), flush: () => saver.flush(), status: saver.status, reason: saver.reason }
}

const readingViews = new Map<string, { primary: 'transcript' | 'notes'; view: 'mine' | 'enhanced' }>()

/** A meeting keeps its reading tab when revisited; an explicit source or recording action can still switch it. */
export function Note({ id, onTitleChange, at, folderSuggestion, onSource, onResumeRequested }: {
  onSource: (s: LibrarySource, match?: string) => void
  id: string; onTitleChange: (meeting: Pick<MeetingView, 'id' | 'title'>) => void
  /** A citation target: null ms selects notes; seq identifies each Open action. */
  at?: { ms: number | null; match?: string; seq: number }
  folderSuggestion?: FolderSuggestion
  onResumeRequested?: () => void
}) {
  const [meetingReadFailed, setMeetingReadFailed] = useState(false)
  const [notesReadFailed, setNotesReadFailed] = useState(false)
  const retryMeeting = useRef<() => void>(() => {})
  const retryNotes = useRef<() => void>(() => {})
  const retryRead = () => { if (meetingReadFailed) retryMeeting.current(); if (notesReadFailed) retryNotes.current() }
  const [m, setM] = useState<MeetingView>()
  const [footer, setFooter] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (!footer) return
    const position = () => document.body.style.setProperty('--note-footer-height', `${innerHeight - footer.getBoundingClientRect().top + 16}px`)
    position()
    const observer = new ResizeObserver(position)
    observer.observe(footer)
    window.addEventListener('resize', position)
    return () => { observer.disconnect(); window.removeEventListener('resize', position); document.body.style.removeProperty('--note-footer-height') }
  }, [footer])
  useEffect(() => { if (m) onTitleChange({ id: m.id, title: m.title }) }, [m?.id, m?.title, onTitleChange])
  const [retryingStop, setRetryingStop] = useState(false)
  const [starting, setStarting] = useState(false)
  const [stopRequested, setFinishing] = useState(false)
  const [startFailed, setStartFailed] = useState(false)
  const [resumeConfirm, setResumeConfirm] = useState(false)
  const [resumeFailed, setResumeFailed] = useState(false)
  const [pausing, setPausing] = useState(false)
  const [pauseFailed, setPauseFailed] = useState<'pause' | 'resume' | null>(null)
  const [notes, setNotes] = useState<NoteView>()
  const [hasTranscript, setHasTranscript] = useState(false)
  const [setup, setSetup] = useState<SetupState>()
  useEffect(() => {
    let active = true, revision = 0
    setHasTranscript(false)
    const load = () => {
      const request = ++revision
      void window.yogurt.transcript.get(id, { last: 1 }).then(lines => {
        if (active && request === revision) setHasTranscript(lines.some(line => !!line.text.trim()))
      })
    }
    const off = window.yogurt.transcript.onSegment(line => { if (line.meetingId === id && line.text.trim()) { revision++; setHasTranscript(true) } })
    const changed = window.yogurt.transcript.onSpeakers(meetingId => { if (meetingId === id) load() })
    const replaced=window.yogurt.transcript.onReplaced?.(meetingId=>{if(meetingId===id)load()})
    load()
    return () => { active = false; off(); changed();replaced?.() }
  }, [id])
  useEffect(() => {
    let active = true, received = false
    const off = window.yogurt.setup.onState(state => { received = true; setSetup(state) })
    void window.yogurt.setup.state().then(state => { if (active && !received) setSetup(state) })
    return () => { active = false; off() }
  }, [])
  const [viewState, setView] = useState<'mine' | 'enhanced'>(() => readingViews.get(id)?.view ?? 'mine')
  const [finishRequested, requestFinish] = useState(false)
  const reducedMotion = useReducedMotion()
  const summaryState = useSummaryPresentation(notes, reducedMotion)
  const hasEnhanced = m?.id === id && m.state !== 'prepared' && m.state !== 'recording' && !!notes && notes.status !== 'idle'
  const finishing = stopRequested && !hasEnhanced
  const summaryPending = notes?.status === 'waiting' || notes?.status === 'writing'
  // Reduced motion selects Summary in the very render that first exposes its tab.
  const instantSummary = finishRequested && hasEnhanced && reducedMotion
  const view = instantSummary ? 'enhanced' : viewState
  /** the person picked a side themselves: it is never switched for them after that */
  const picked = useRef(readingViews.has(id))
  const typing = useRef(false)
  const [primaryState, setPrimary] = useState<'transcript' | 'notes'>(() => readingViews.get(id)?.primary ?? 'notes')
  const primary = instantSummary ? 'notes' : primaryState
  const readingScroll = useScrollMemory<HTMLElement>(`note/${id}/${view}`, !!m && !!notes && primary === 'notes')
  useEffect(() => { if (m && notes) readingViews.set(id, { primary, view }) }, [id, m, notes, primary, view])
  const [transcriptVisited, setTranscriptVisited] = useState(primary === 'transcript')
  useEffect(() => { if (primary === 'transcript') setTranscriptVisited(true) }, [primary])
  const [tabPointer, setTabPointer] = useState(false)
  const panels = useRef<HTMLDivElement & { startViewTransition?: (update: () => void) => ViewTransition }>(null)
  const panelTransition = useRef<ViewTransition | null>(null)
  const tabRequest = useRef(0)
  useEffect(() => () => { tabRequest.current++; panelTransition.current?.skipTransition() }, [id])
  const primaryTabs = useRef<HTMLDivElement>(null)
  const transcriptButton = useRef<HTMLButtonElement>(null)
  const notesButton = useRef<HTMLButtonElement>(null)
  const summaryButton = useRef<HTMLButtonElement>(null)
  const [rewriteOpen, setRewriteOpen] = useState(false)
  const [editedHere, setEditedHere] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [namingFolder, setNamingFolder] = useState(false)
  /** the bounded reading area holds the chat beside the current view */
  const [transcriptToolbar, setTranscriptToolbar] = useState<HTMLDivElement | null>(null)
  const [chatAnchor, setChatAnchor] = useState<HTMLDivElement | null>(null)
  /** the notes as shown, for merging a new view from the app outside a state update */
  const current = useRef<NoteView | undefined>(undefined)
  /** what the recorder has to say right now (a hint, a hiccup), shown under the note too */
  const [recorder, setRecorder] = useState<WidgetView | null>(null)
  const hint = recorder?.note
  const sourceDone = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!at || !notes || !m || sourceDone.current === at.seq) return
    sourceDone.current = at.seq
    picked.current = true
    setPrimary(at.ms === null ? 'notes' : 'transcript')
    if (at.ms === null) {
      const inSummary = at.match && citationTargetIndex([notes.enhanced ?? ''], at.match) >= 0
      setView(hasEnhanced && (inSummary || !at.match) ? 'enhanced' : 'mine')
    }
  }, [at?.seq, notes, m, hasEnhanced])

  // the recorder's hints (the widget shows them too), while this meeting records
  const isRecording = m?.id === id && m.state === 'recording'
  const togglePause = async () => {
    const paused = !m?.paused
    setPausing(true); setPauseFailed(null)
    try {
      if (!await window.yogurt.meetings.setPaused(id, paused)) setPauseFailed(paused ? 'pause' : 'resume')
      else setM(await window.yogurt.meetings.get(id))
    } catch { setPauseFailed(paused ? 'pause' : 'resume') }
    finally { setPausing(false) }
  }
  useEffect(() => {
    if (!isRecording) { setRecorder(null); return }
    const take = (v: WidgetView | null) => setRecorder(v && v.meetingId === id ? v : null)
    void window.yogurt.widget.state().then(take)
    return window.yogurt.widget.onState(take)
  }, [id, isRecording])

  useEffect(() => {
    let version = 0
    const load = () => {
      const request = ++version
      void window.yogurt.meetings.get(id).then(value => {
        if (request !== version) return
        setMeetingReadFailed(!value)
        if (value) setM(value)
      }, () => { if (request === version) setMeetingReadFailed(true) })
    }
    setMeetingReadFailed(false); retryMeeting.current = load; load()
    const off = window.yogurt.meetings.onChange(load)
    return () => { version++; off() }
  }, [id])

  useEffect(() => {
    requestFinish(false)
    setTabPointer(false); setNotes(undefined); current.current = undefined; setView(readingViews.get(id)?.view ?? 'mine'); picked.current = readingViews.has(id); typing.current = false; setEditedHere(false); setRewriteOpen(false); setRenaming(false); setDeleting(false); setResumeConfirm(false); setResumeFailed(false)
    const show = (v: NoteView) => {
      const first = !current.current
      // what they typed here is newer than any copy from the app; notes written again for new people replace it unless edited (noteMerge.ts)
      const { view, keptEdits } = mergeNoteView(current.current, v)
      if (keptEdits) window.yogurt.notes.keptEdits(id)
      current.current = view
      setNotes(view)
      // A reopened failed draft is the useful place to resume, including Settings' Open note action.
      const failedSide = v.saves?.mine?.status === 'failed' ? 'mine' : v.saves?.enhanced?.status === 'failed' ? 'enhanced' : undefined
      if (first && failedSide) { picked.current = true; setView(failedSide); setPrimary('notes') }
      // Enhanced once there is something to show there, unless they chose, or are typing in their own notes
      if (v.status !== 'idle' && !picked.current && !typing.current) setView('enhanced')
    }
    let version = 0
    const off = window.yogurt.notes.onChange(v => { if (v.meetingId === id) { version++; setNotesReadFailed(false); show(v) } })
    const load = () => {
      const request = ++version
      void window.yogurt.notes.get(id).then(v => { if (request === version) { setNotesReadFailed(false); show(v) } },
        () => { if (request === version) setNotesReadFailed(true) })
    }
    setNotesReadFailed(false); retryNotes.current = load; load()
    return () => { version++; off() }
  }, [id])

  useEffect(() => { current.current = notes }, [notes])
  useEffect(() => {
    if (m?.state !== 'recording' && (m?.stopSavePending || notes?.status !== 'idle')) setFinishing(false)
  }, [m?.state, m?.stopSavePending, notes?.status])
  useEffect(() => {
    if (!finishRequested || !hasEnhanced) return
    const enter = () => {
      pickTab('notes', 'enhanced', true)
      summaryButton.current?.focus({ preventScroll: true })
    }
    if (reducedMotion) { enter(); return }
    const timer = setTimeout(enter, motion.micro)
    return () => clearTimeout(timer)
  }, [id, finishRequested, hasEnhanced, reducedMotion])
  const mineSave = useAutosave(id, 'mine', notes?.mine ?? '', notes?.saves?.mine)
  const enhancedSave = useAutosave(id, 'enhanced', notes?.enhanced ?? '', notes?.saves?.enhanced)

  useLayoutEffect(() => {
    const tabs = primaryTabs.current
    if (!tabs) return
    const position = () => {
      const active = (primary === 'transcript' ? transcriptButton : view === 'enhanced' && summaryButton.current ? summaryButton : notesButton).current
      if (!active) return
      const tab = active.getBoundingClientRect(), row = tabs.getBoundingClientRect()
      const x = getComputedStyle(tabs).direction === 'rtl' ? tab.right - row.right : tab.left - row.left
      tabs.style.setProperty('--tab-x', `${x}px`)
      tabs.style.setProperty('--tab-width', `${tab.width}px`)
    }
    position()
    const resize = new ResizeObserver(position)
    resize.observe(tabs)
    for (const button of [transcriptButton.current, notesButton.current, summaryButton.current]) if (button) resize.observe(button)
    return () => resize.disconnect()
  }, [primary, view, m?.state, notes?.status])

  const summarizing = finishing || summaryPending
  const resumeHandled = useRef(false)
  useEffect(() => {
    if (!onResumeRequested) { resumeHandled.current = false; return }
    if (resumeHandled.current || !m || !notes || summarizing || starting || m.stopSavePending) return
    resumeHandled.current = true
    onResumeRequested()
    if (m.trashedAt == null && !m.stopSavePending && (m.state === 'stopped' || m.state === 'done')) void resumeRecording()
  }, [onResumeRequested, m, notes, summarizing, starting])

  const [hasAudio,setHasAudio]=useState(false)
  useEffect(()=>{let active=true;const load=()=>void window.yogurt.audio.tracks(id).then(tracks=>{if(active)setHasAudio(!!tracks.length)});load();const off=window.yogurt.meetings.onChange(load);return()=>{active=false;off()}},[id])
  const openedTranscription=useRef<string | undefined>(undefined)
  useLayoutEffect(()=>{if(m&&openedTranscription.current!==id){openedTranscription.current=id;if(transcriptionBusy(m.transcriptionState))setPrimary('transcript')}},[m,id])
  const readFailed = meetingReadFailed || notesReadFailed
  if (!m || !notes) return readFailed ? <ReadError testId="note-read-error" retry={retryRead} /> : <LoadingContent pending skeleton={<Loading layout="note" />} className="loading-note-frame" />
  const recording = m.state === 'recording'
  /** in the Trash: it can be read and restored, not recorded into */
  const trashed = m.trashedAt != null
  const minutes = m.endedAt ? Math.max(1, Math.round((m.durationMs ?? (m.endedAt - m.startedAt)) / 60_000)) : null
  const shown = hasEnhanced ? view : 'mine'
  const resumeLabel = summaryPending ? t('Stop summarizing') : t('Resume recording')

  const pick = (v: 'mine' | 'enhanced') => { picked.current = true; setView(v); mineSave.flush(); enhancedSave.flush() }
  const pickPrimary = (next: 'transcript' | 'notes', pointer = false) => {
    setTabPointer(pointer)
    if (next === primaryState) return
    setPrimary(next)
    if (next === 'transcript') setRewriteOpen(false)
    void mineSave.flush(); void enhancedSave.flush()
  }
  const pickTab = (next: 'transcript' | 'notes', side?: 'mine' | 'enhanced', pointer = false) => {
    requestFinish(false)
    const request = ++tabRequest.current
    panelTransition.current?.skipTransition()
    const update = () => {
      if (request !== tabRequest.current) return
      pickPrimary(next, pointer)
      if (side) pick(side)
    }
    const root = panels.current
    if ((next === primary && (!side || side === shown)) || !root?.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      update()
      return
    }
    // Snapshot just the reading panels; the live editor, header and Ask keep their own state.
    panelTransition.current = root.startViewTransition(() => flushSync(update))
    void panelTransition.current.ready.catch(() => {}) // A newer click or navigation skips this snapshot.
  }
  const primaryKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const buttons = [transcriptButton.current, notesButton.current, ...(hasEnhanced ? [summaryButton.current] : [])]
    const direction = getComputedStyle(e.currentTarget).direction === 'rtl' ? -1 : 1
    const step = e.key === 'ArrowRight' ? direction : -direction
    const index = buttons.indexOf(e.currentTarget)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + step + buttons.length) % buttons.length
    buttons[next]?.click()
    buttons[next]?.focus({ preventScroll: true })
  }
  const saveAll = async () => (await Promise.all([mineSave.flush(), enhancedSave.flush()])).every(Boolean)
  const startPrepared = async () => {
    if (starting) return
    setStarting(true); setStartFailed(false)
    try {
      if (!await saveAll()) return
      const result = await window.yogurt.meetings.startPrepared(id)
      setStartFailed('error' in result)
      if (!('error' in result)) { setPrimary('notes'); setView('mine') }
    } catch { setStartFailed(true) }
    finally { setStarting(false) }
  }
  const resumeRecording = async (confirmed = false) => {
    if (starting || summarizing) return
    if ((notes.edited || editedHere) && !confirmed) { setResumeConfirm(true); return }
    setResumeConfirm(false); setStarting(true); setResumeFailed(false)
    try {
      if (!await saveAll()) return
      const result = await window.yogurt.meetings.resume(id)
      if ('error' in result) setResumeFailed(true)
      else { picked.current = false; requestFinish(false); setPrimary('notes'); setView('mine'); setEditedHere(false) }
    } catch { setResumeFailed(true) }
    finally { setStarting(false) }
  }
  const saveStatus = mineSave.status === 'failed' || enhancedSave.status === 'failed' ? 'failed'
    : mineSave.status === 'saving' || enhancedSave.status === 'saving' ? 'saving' : 'saved'
  const writeAgain = async (note?: string) => {
    if (!await saveAll()) return
    setEditedHere(false)
    void window.yogurt.notes.writeAgain(id, note)
  }
  const hasSummary = !!notes.enhanced?.trim()
  const transcribing=transcriptionBusy(m.transcriptionState)
  const runTranscript=async(again=false)=>{if(!await saveAll())return;try{const started=await window.yogurt.transcript.run(id,again);if(started)setPrimary('transcript')}catch{toasts.add({title:t("Yogurt couldn't transcribe this file.")})}}
  const transcriptReason=recording||m.stopSavePending?t('Available after recording'):transcribing?t('Transcribing…'):summarizing?t('Summarizing…'):!hasAudio?t('Audio is unavailable.'):undefined
  const generation = summaryAction({ hasSummary, hasContent: hasTranscript || !!notes.mine.trim(), recording, busy: summarizing, downloading: !!(setup?.notesDownloading || setup?.notesError), trashed })
  if(generation&&transcribing)generation.reason=t('Transcribing…')
  const requestRewrite = () => {
    if (!generation || generation.reason) return
    if (hasSummary) setRewriteOpen(true)
    else void writeAgain()
  }

  return (
    <LoadingContent onReady={()=>document.dispatchEvent(new CustomEvent('audio-upload-note-ready',{detail:id}))} pending={false} skeleton={<Loading layout="note" />} className="loading-note-frame"><div data-testid="note" className="document-main relative flex h-full bg-bg">
      {resumeConfirm && <Modal testId="resume-confirm" role="alertdialog" title={t('Record more in this note?')}
        description={t('Your notes, transcript, and previous audio are kept. Your edited summary will be replaced when you stop recording.')}
        onCancel={() => setResumeConfirm(false)}>
        <div className="modal-actions">
          <button data-testid="resume-yes" onClick={() => void resumeRecording(true)} className="modal-button primary">{t('Resume recording')}</button>
          <ModalClose data-dialog-cancel data-testid="resume-cancel" className="workspace-button">{t('Cancel')}</ModalClose>
        </div>
      </Modal>}
      <div data-testid="note-topbar" className="note-topbar no-drag fixed end-4 top-[10px] z-[60]">
          <NoteMenu key={id} transcription={{reason:transcriptReason,run:()=>void runTranscript(true)}} generation={generation} hasSummary={hasSummary} edited={notes.edited || editedHere} rewriteOpen={rewriteOpen} setRewriteOpen={setRewriteOpen}
            onWriteAgain={(note) => { if (!generation || generation.reason) return; pickPrimary('notes'); pick('enhanced'); void writeAgain(note) }} recording={recording} savePending={m.stopSavePending} trashed={trashed} onRename={() => setRenaming(true)} onDelete={() => { void saveAll().then((saved) => { if (!saved) return; if (trashed) setDeleting(true); else void moveToTrash(id, `/note/${id}`) }) }}
            folders={(close) => <FolderPicker testId="note-menu-folders" meetingId={id} onNew={() => { close(); setNamingFolder(true) }} />} />
      </div>
      <div className="note-layout relative flex min-w-0 flex-1 flex-col" data-tab-pointer={tabPointer}>
        <header className="note-header note-page-width">
          <Title id={id} title={m.title} editing={renaming} onEdit={setRenaming} />
          <div className="note-meta-row">
            <div className="note-metadata" data-testid="note-metadata">
              <NoteDate m={m} />
              <People m={m} />
              <FolderChip meetingId={id} onNew={() => setNamingFolder(true)} suggestion={folderSuggestion} />
            </div>
            <div data-testid={recording ? 'rec-bar' : 'note-bar'} className="note-header-actions">
              {recording && !finishing && <span className="note-recording-status">
                <LevelBars height={14} bars={3} testId="note-wave" paused={!!m.paused} className="text-muted" />
                <RecordingTime view={recorder} />
              </span>}
              <div data-testid="note-state" data-state={m.state} data-paused={!!m.paused} className="note-recording-group" data-treatment={RECORDING_CONTROL_TREATMENT} data-recording={recording && !finishing} role="group" aria-label={recording ? m.paused ? t('Paused') : t('Recording') : t('Meeting controls')}>
                {recording && !finishing && <>
                  <RecordingAction data-testid="note-pause" disabled={pausing} onClick={() => { void togglePause() }}
                    label={m.paused ? t('Resume recording') : t('Pause recording')} className="note-record-action note-pause-action">
                    <Swap show={m.paused ? 'play' : 'pause'} options={{ pause: <Pause size={14} fill="currentColor" strokeWidth={0} />, play: <Play size={14} fill="currentColor" strokeWidth={0} /> }} />
                  </RecordingAction>
                  <RecordingAction data-testid="note-stop" onClick={(e) => { requestFinish(true); picked.current = true; setView('mine'); setFinishing(true); setTabPointer(e.detail > 0); window.yogurt.meetings.stop(id) }} label={t('Stop recording')} className="note-record-action note-finish-action">
                    <span className="note-stop-label">{t('Stop')}</span>
                  </RecordingAction>
                </>}
                {finishing && <span data-testid="note-finishing" role="status" className="note-finishing">{t('Stopping…')}</span>}
                {!finishing && (summaryPending || (!transcribing && m.source !== 'audio-file')) && (m.state === 'stopped' || m.state === 'done') && !m.stopSavePending && !trashed && <button data-testid="note-resume" disabled={starting && !summaryPending} onClick={() => { if (summaryPending) void window.yogurt.notes.stop(id).catch(console.error); else void resumeRecording() }}
                  aria-label={resumeLabel} className="workspace-button note-resume-action" title={summaryPending ? resumeLabel : t('Resume recording in this note')}>
                  {!summaryPending && <Mic size={14} aria-hidden="true" />}
                  <SwapText text={starting && !summaryPending ? t('Preparing…') : resumeLabel} />
                </button>}
                {m.state === 'prepared' && !trashed && <button data-testid="note-start" disabled={starting} onClick={() => { void startPrepared() }} className="note-record-action primary">
                  <Mic size={14} strokeWidth={1.75} aria-hidden="true" />{starting ? t('Starting…') : t('Start recording')}
                </button>}
              </div>
              {transcribing&&<TranscriptionControl state={m.transcriptionState!} onStop={()=>void window.yogurt.transcript.stop(id).catch(()=>toasts.add({title:t("Yogurt couldn't transcribe this file.")}))}/>}
              <ShareMenu id={id} shown={shown} status={notes.status} hasEnhanced={notes.enhanced != null} beforeUse={saveAll} />
            </div>
          </div>
            {trashed && (
              <div data-testid="note-trashed" role="status" className="mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-card px-4 py-3 text-[13px] leading-relaxed">
                <Trash2 size={16} aria-hidden="true" className="shrink-0 text-muted" />
                <p className="min-w-48 flex-1">{t('This note is in the Trash.')}</p>
                <button data-testid="note-restore" onClick={() => void window.yogurt.meetings.restore(id)} className="workspace-button"><RotateCcw size={13} aria-hidden="true" />{t('Restore')}</button>
              </div>
            )}

          <div ref={primaryTabs} className="note-primary-tabs" data-summary-arriving={finishRequested && hasEnhanced && !reducedMotion}>
            <div role="tablist" aria-label={t('Meeting view')} className="contents">
            <button ref={transcriptButton} id="note-transcript-tab" data-testid="note-transcript-toggle" role="tab" aria-selected={primary === 'transcript'} aria-controls="note-transcript-panel"
              tabIndex={primary === 'transcript' ? 0 : -1} onKeyDown={primaryKey} onClick={(e) => pickTab('transcript', undefined, e.detail > 0)}>
              {t('Transcript')}
            </button>
            <button ref={notesButton} id="note-notes-tab" data-testid="note-notes-tab" role="tab" aria-selected={primary === 'notes' && shown === 'mine'} aria-controls="note-notes-panel"
              data-version={shown} tabIndex={primary === 'notes' && shown === 'mine' ? 0 : -1} onKeyDown={primaryKey}
              onClick={(e) => pickTab('notes', 'mine', e.detail > 0)}>
              {t('My notes')}
            </button>
            {hasEnhanced && <button ref={summaryButton} id="note-summary-tab" data-testid="note-summary-tab" role="tab" aria-selected={primary === 'notes' && shown === 'enhanced'} aria-controls="note-notes-panel"
              aria-describedby={summaryPending ? 'note-summary-phase' : undefined}
              tabIndex={primary === 'notes' && shown === 'enhanced' ? 0 : -1} onKeyDown={primaryKey}
              onClick={(e) => pickTab('notes', 'enhanced', e.detail > 0)}>
              {t('Summary')}{summaryPending && <span className="summary-writing-mark" aria-hidden="true" />}
            </button>}
            </div>
            {hasEnhanced && summaryPending && <span id="note-summary-phase" hidden>{notes.status === 'waiting' ? t('Preparing…') : t('Writing the summary')}</span>}
            {primary === 'transcript' && <div ref={setTranscriptToolbar} className="note-primary-tools" />}
            <span data-testid="note-tab-indicator" className="note-tab-indicator" aria-hidden="true" />
          </div>
        </header>
        {readFailed && <InlineError testId="note-read-error" retry={retryRead} />}
        <div ref={setChatAnchor} className="note-reading-area">
          <div ref={panels} className="note-panels">
          <NoteReadingPane active={primary === 'notes'} summary={shown === 'enhanced'} generating={shown === 'enhanced' && ['waiting', 'rewriting', 'handoff', 'reset', 'streaming'].includes(summaryState)} resetting={shown === 'enhanced' && summaryState === 'reset'} writing={shown === 'enhanced' && summaryState === 'streaming'} scroll={readingScroll}>
                {shown === 'mine' ? <Editor
                  focus={primary === 'notes' && at?.ms === null ? at : undefined} testId="note-mine" label={t('My notes')} className="min-h-[40vh]" markdown={notes.mine} placeholder={t('You can add notes here to guide the summary.')}
                  onChange={(md) => { typing.current = true; const next = { ...current.current!, mine: md }; current.current = next; setNotes(next); mineSave.change(md) }}
                  onBlur={() => { typing.current = false; mineSave.flush() }}
                /> : <Enhanced key={id} presentation={summaryState} focus={primary === 'notes' && at?.ms === null ? at : undefined} notes={notes} disabled={starting} onChange={(md) => { setEditedHere(true); const next = { ...current.current!, enhanced: md }; current.current = next; setNotes(next); enhancedSave.change(md) }} onBlur={enhancedSave.flush} onRetry={requestRewrite} />}
          </NoteReadingPane>
          {(primary === 'transcript' || transcriptVisited) && <section hidden={primary !== 'transcript'} id="note-transcript-panel" role="tabpanel" aria-labelledby="note-transcript-tab" className="note-content note-transcript-pane">
            <Transcript notice={
              hasAudio && (m.transcriptionPending || !hasTranscript) || m.transcriptionState === 'waiting-model' || m.transcriptionState === 'waiting-recording'
                ? <TranscriptionNotice state={m.transcriptionState} hasLines={hasTranscript} onContinue={() => void runTranscript()} disabled={recording || !!m.stopSavePending} />
                : !hasAudio && m.transcriptionState === 'error'
                  ? <InlineError testId="upload-preparation-failed"><span>{t("Yogurt couldn't read this audio file.")}</span><button className="workspace-button" onClick={() => void openAudioUpload()}>{t('Upload a file')}</button></InlineError>
                  : null
            } id={id} processing={transcribing} replacing={!!m.transcriptionAgain} recording={recording} active={primary === 'transcript'} inline toolbar={transcriptToolbar} focus={at?.ms != null ? { ...at, ms: at.ms } : undefined} />
          </section>}
          </div>
        </div>
        <footer ref={setFooter} className="note-footer">
            {m.stopSavePending && (
              <InlineError testId="note-stop-unsaved" className="mt-5">
                <span>{t("Recording stopped. Yogurt couldn't save when it ended. Keep Yogurt open and try again.")}</span>
                <button data-testid="note-stop-retry" disabled={retryingStop} className="workspace-button" onClick={() => {
                  setRetryingStop(true)
                  void window.yogurt.meetings.retryStopSave(id).then((saved) => {
                    if (saved) transcriptButton.current?.focus({ preventScroll: true })
                  }).catch(() => {}).finally(() => setRetryingStop(false))
                }}>{retryingStop ? t('Saving…') : t('Try again')}</button>
              </InlineError>
            )}
          {primary === 'notes' && shown === 'enhanced' && notes.status === 'done' && notes.peopleChanged && !rewriteOpen && (
            <div data-testid="note-people-changed" className="pointer-events-auto mx-auto mt-3 flex w-fit max-w-[calc(100%-32px)] flex-wrap items-center gap-3 rounded-xl border border-line bg-float px-4 py-2 text-[13px] shadow-[var(--shadow)]">
              <span>{t('The attendee list has changed.')}</span>
              <button data-testid="note-people-write-again" onClick={requestRewrite} className="workspace-button primary">{t('Regenerate summary')}</button>
            </div>
          )}
          {saveStatus === 'failed' && (
            <InlineError testId="note-save-status" className="pointer-events-auto mx-auto mt-3 w-fit max-w-[calc(100%-32px)]">
              <span data-testid="note-save-warning">{mineSave.reason === 'too-long' || enhancedSave.reason === 'too-long' ? t('This note is too long to save. Shorten it and try again.') : t("Couldn't save your changes")}</span>
              <button data-testid="note-save-retry" className="workspace-button" onClick={() => { void saveAll() }}>{t('Try again')}</button>
            </InlineError>
          )}
          {startFailed && <p role="alert" className="pointer-events-auto mx-auto mt-3 w-fit text-[13px] text-danger">{t("Yogurt couldn't start the notes. Try again in a moment.")}</p>}
          {resumeFailed && <p data-testid="note-resume-failed" role="alert" className="pointer-events-auto mx-auto mt-3 w-fit max-w-[calc(100%-32px)] text-[13px] text-danger">{t("Couldn't resume recording. Your existing note and audio are kept. Try again.")}</p>}
          {pauseFailed && recording && <p role="alert" className="pointer-events-auto mx-auto mt-3 w-fit text-[13px] text-danger">{pauseFailed === 'pause' ? t("Couldn't pause the recording. Try again.") : t("Couldn't resume the recording. Try again.")}</p>}
          {recording && hint && <RecordingHint hint={hint} />}
          <div className="note-footer-bar">
          <div className="note-status pointer-events-auto flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
            {(recording || m.state === 'prepared') && <><MicMenu recording={recording} paused={recording && m.paused} /><SpokenMenu /><span aria-hidden="true">·</span></>}
            {saveStatus !== 'failed' && <>
              <p data-testid="note-save-status" data-state={saveStatus} role="status" className="flex items-center gap-1.5">
                <Lock size={10} aria-hidden="true" />
                <span>{saveStatus === 'saving' ? t('Saving…') : osWords({ mac: t('Saved on this Mac'), other: t('Saved on this computer') })}</span>
              </p>
              <span aria-hidden="true">·</span>
            </>}
            {minutes != null && <><span data-testid="note-duration">{t('{count} min', { count: minutes })}</span><span aria-hidden="true">·</span></>}
            {t('Yogurt can make mistakes.')}
          </div>
          <Ask id={id} recording={recording} anchor={chatAnchor} onSource={onSource} />
          </div>
        </footer>
      </div>
      {deleting && <DeleteNote id={id} title={m.title} onDone={() => setDeleting(false)} />}
      {namingFolder && <FolderName onDone={(made) => { setNamingFolder(false); if (made) void window.yogurt.folders.add(made.id, id) }} />}
    </div></LoadingContent>
  )
}

/** The note's title: click it to rename; Return or clicking away saves, Escape keeps the old one */
function Title({ id, title, editing, onEdit }: { id: string; title: string; editing: boolean; onEdit: (on: boolean) => void }) {
  const [draft, setDraft] = useState(title)
  const cancelled = useRef(false)
  useEffect(() => { if (editing) { setDraft(title); cancelled.current = false } }, [editing, title])
  const cls = 'note-title-type w-full font-sans'
  if (!editing) {
    return (
      <h1 data-testid="note-title" className={cls}>
        <button onClick={() => onEdit(true)} title={t('Rename')} className="note-title-btn -mx-1 rounded-lg px-1 text-start">{title}</button>
      </h1>
    )
  }
  const done = () => {
    onEdit(false)
    if (!cancelled.current && draft.trim() && draft.trim() !== title) void window.yogurt.meetings.rename(id, draft)
  }
  return (
    <input data-testid="note-title-input" aria-label={t('Title')} autoFocus value={draft} maxLength={200}
      onFocus={(e) => e.currentTarget.select()} onChange={(e) => setDraft(e.target.value)} onBlur={done}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur() } }}
      className={`${cls} -mx-1 rounded-lg bg-transparent px-1 outline-none ring-1 ring-line focus-visible:ring-accent`} />
  )
}

/** The enhanced side: waiting, the draft as it is written, the saved notes (editable), or what went wrong */
function Enhanced({ notes, presentation, disabled, onChange, onBlur, onRetry, focus }: { presentation: ReturnType<typeof useSummaryPresentation>; focus?: { match?: string; seq: number }; notes: NoteView; disabled?: boolean; onChange: (md: string) => void; onBlur: () => void; onRetry: () => void }) {
  const { status } = notes
  const handoff = presentation === 'handoff' || presentation === 'reset'
  const writing = presentation === 'waiting' || presentation === 'streaming' || handoff
  const rewriting = presentation === 'rewriting'
  const surface = useRef<HTMLDivElement>(null), height = useRef(0)
  const previous = useRef(presentation)
  useLayoutEffect(() => {
    const pane = surface.current?.closest<HTMLElement>('.note-notes-pane')
    if (status === 'failed' && previous.current === 'streaming' && pane) pane.scrollTop = 0
    previous.current = presentation
  }, [presentation, status])
  useLayoutEffect(() => { if (!handoff) height.current = surface.current?.offsetHeight ?? 0 }, [handoff, rewriting, notes.enhanced])
  // Warm the normal unroll and ink during the fade, so the first words are ready at the handoff.
  const draft = useSmoothText(writing ? notes.draft : '', writing, { minCommitMs: 32 })
  if (presentation === 'failed') {
    return (
      <InlineError testId="note-enhanced-failed">
        <span>{t("Yogurt couldn't generate this summary.")}</span>
        <button onClick={onRetry} className="workspace-button">{t('Try again')}</button>
      </InlineError>
    )
  }
  if (presentation === 'stopped') return <div className="summary-stopped">
    <p role="status">{t('Summary stopped.')}</p>
    <button type="button" onClick={onRetry} className="summary-generate flex items-center gap-2.5 rounded-xl px-3 py-2 text-start text-sm whitespace-nowrap text-ink hover:bg-[var(--line)] focus-visible:bg-[var(--line)]"><RotateCcw size={15} strokeWidth={1.75} aria-hidden="true" className="text-muted" />{t('Generate summary')}</button>
  </div>
  if (presentation === 'empty') return <p data-testid="note-enhanced-empty" className="text-[15px] text-muted">{t('There is no transcript or typed note to summarize.')}</p>
  if (presentation === 'waiting') {
    return (
      <NotesModelWait downloading={(percent) => (
        <p data-testid="note-enhanced-model-download" role="status" className="text-[15px] text-muted">{t("Your summary is waiting for Yogurt's AI to download.")} {percent && <span className="whitespace-nowrap">{percent}</span>}</p>
      )}>
        <SummaryWaiting part={status === 'writing' ? notes.part : undefined} />
      </NotesModelWait>
    )
  }
  return (
    <div data-testid="note-enhanced" data-status={status} className={presentation === 'streaming' ? 'streaming' : ''}>
      {status === 'failed' && <InlineError testId="note-enhanced-rewrite-failed" className="mb-6">
        <span>{t("Yogurt couldn't regenerate the summary, so your previous version is still shown.")}</span>
        <button onClick={onRetry} className="workspace-button">{t('Try again')}</button>
      </InlineError>}
      {rewriting && <SummaryWaiting outline={false} part={status === 'writing' ? notes.part : undefined} />}
      <div ref={surface} className="summary-rewrite" data-rewriting={rewriting} data-handoff={handoff} data-resetting={presentation === 'reset'} style={handoff ? { minHeight: height.current } : undefined}>
        <div className="summary-result">
          <Editor focus={focus} testId="note-enhanced-editor" label={t('Summary')} className="enhanced" markdown={handoff ? notes.enhanced ?? '' : writing ? draft : notes.enhanced ?? ''} streaming={writing && !handoff} editable={!writing && !rewriting && !disabled} onChange={onChange} onBlur={onBlur} />
        </div>
      </div>
      {/* the caret dot and the Summarizing pill show progress; a visible label here would ride the end of the text up and down */}
      {writing && <p className="sr-only" aria-live="polite">{t('Generating notes…')}</p>}
    </div>
  )
}
