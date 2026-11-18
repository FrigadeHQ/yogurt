import { AudioUploadWhen } from './AudioUploadWhen'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FileAudio } from 'lucide-react'
import { t } from '../../../shared/i18n'
import { type AudioUploadFile, type AudioUploadStatus } from '../../../shared/audioUpload'
import { motion } from '../motion'
import { Loader } from './Icons'
import { Modal } from './Modal'
import { toasts } from './TrashToast'

export function AudioUploadDialog({ file, durationMs, status, closing, onStart, onInspect, onCancel }: {
  file: AudioUploadFile; closing?:boolean; durationMs?: number; status?: AudioUploadStatus; onInspect?: () => void
  onStart: (title: string, at: number) => void; onCancel: () => void
}) {
  const inferred=Math.min(Date.now(),file.modifiedAt-(durationMs??0))
  const [at,setAt]=useState(inferred)
  useLayoutEffect(()=>setAt(inferred),[file.token,durationMs])
  const busy=!!status&&status.phase!=='error',reading=status?.phase==='reading'
  const heading=reading?t('Reading the file…'):t('Upload a file')
  return <Modal closing={closing} title={heading} onCancel={onCancel} busy={busy} testId="audio-upload">
    <form onSubmit={e=>{e.preventDefault();if(!busy){if(durationMs==null)onInspect?.();else onStart(file.title,at)}}}>
      <div className="audio-upload-fields">
        <p className="audio-upload-file">{reading?<Loader size={16} aria-hidden="true"/>:<FileAudio size={16} aria-hidden="true"/>}<span title={file.name}>{file.name}</span></p>
        {durationMs!=null&&<AudioUploadWhen disabled={busy} at={at} durationMs={durationMs} onChange={setAt}/>}
        {status?.phase==='error'&&<p className="text-xs text-danger" role="alert">{status.error==='busy'?t('Finish recording before uploading a file.'):status.error==='format'?t('This audio format is not supported.'):t("Yogurt couldn't read this audio file.")}</p>}
      </div>
      <div className="modal-actions audio-upload-actions"><button type="button" className="ghost-btn" data-dialog-cancel disabled={!!closing||status?.phase==='done'||status?.phase==='cancelling'} onClick={onCancel}>{t('Cancel')}</button>{!reading&&<button type="submit" disabled={busy} aria-busy={busy} className="workspace-button primary audio-upload-submit"><span className="audio-upload-submit-label">{status?.phase==='error'?t('Try again'):t('Transcribe')}</span>{busy&&<span className="audio-upload-submit-icon" aria-hidden="true"><Loader size={14}/></span>}</button>}</div>
    </form>
  </Modal>
}

export function AudioUpload({ file, onClose, onCreated }: { file: AudioUploadFile; onClose: () => void; onCreated?: (id: string) => void }) {
  const [status, setStatus] = useState<AudioUploadStatus | undefined>({ phase: 'reading' })
  const [durationMs, setDuration] = useState<number>()
  const [attempt, setAttempt] = useState(0)
  const opening=useRef<string|undefined>(undefined)
  const [closing,setClosing]=useState(false)
  useEffect(()=>{const ready=(event:Event)=>{if((event as CustomEvent).detail===opening.current)setClosing(true)};document.addEventListener('audio-upload-note-ready',ready);return()=>document.removeEventListener('audio-upload-note-ready',ready)},[])
  useEffect(() => {
    let active = true
    setStatus({ phase: 'reading' })
    void Promise.all([window.yogurt.audioUpload.inspect(file.token), new Promise(resolve => setTimeout(resolve, motion.surface))]).then(([duration]) => {
      if (active) { setDuration(duration); setStatus(previous => previous?.phase === 'cancelling' ? previous : undefined) }
    }, () => { if (active) setStatus(previous => previous?.phase === 'cancelling' ? previous : { phase: 'error', error: 'read' }) })
    return () => { active = false }
  }, [file.token, attempt])
  useEffect(() => {
    return window.yogurt.audioUpload.onStatus((token, next) => {
      if (token !== file.token) return
      setStatus(next)
      if ((next.phase==='preparing'||next.phase==='done')&&next.meetingId&&!opening.current) { opening.current=next.meetingId;onCreated?.(next.meetingId);window.yogurt.nav.go(`/note/${next.meetingId}`) }
    })
  }, [file, onClose, onCreated])
  return <AudioUploadDialog closing={closing} file={file} durationMs={durationMs} status={status} onInspect={() => setAttempt(n => n + 1)} onStart={(title, at) => {
    setStatus({ phase: 'preparing' })
    void window.yogurt.audioUpload.start(file.token, title, at).catch(() => setStatus({ phase: 'error', error: 'read' }))
  }} onCancel={() => {if(opening.current){onClose();return} setStatus({ phase: 'cancelling' }); void window.yogurt.audioUpload.cancel(file.token).then(onClose, () => setStatus({ phase: 'error', error: 'read' })) }} />
}

/** The upload survives route changes when a call starts or another note opens. */
export async function openAudioUpload(onCreated?: (id: string) => void) {
  try {
    const file = await window.yogurt.audioUpload.pick()
    if (file) document.dispatchEvent(new CustomEvent('audio-upload-open', { detail: { file, onCreated } }))
  } catch { toasts.add({ title: t("Yogurt couldn't read this audio file.") }) }
}
export function AudioUploadHost() {
  const [request, setRequest] = useState<{ file: AudioUploadFile; onCreated?: (id: string) => void }>()
  useEffect(() => {
    const open = (event: Event) => setRequest((event as CustomEvent).detail)
    document.addEventListener('audio-upload-open', open)
    return () => document.removeEventListener('audio-upload-open', open)
  }, [])
  return request ? <AudioUpload file={request.file} onClose={() => setRequest(undefined)} onCreated={request.onCreated} /> : null
}
