import { useEffect, useRef, useState } from 'react'
import { t } from '../../../shared/i18n'
import { Modal } from './Modal'

type Job = Awaited<ReturnType<typeof window.yogurt.processing.pending>>[number]

function localTime(at: number) {
  const date = new Date(at)
  return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

export function ProcessingSchedule() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [selected, setSelected] = useState<string>()
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const dismissed = useRef(new Set<string>())
  useEffect(() => {
    let current = true
    let request = 0
    const refresh = () => {
      const revision = ++request
      void window.yogurt.processing.pending().then(list => {
        if (current && revision === request) setJobs(list)
      })
    }
    const off = window.yogurt.meetings.onChange(refresh)
    refresh()
    return () => { current = false; off() }
  }, [])
  const job = jobs.find(item => item.id === selected)
  const open = (item: Job) => {
    const [day, hour] = localTime(item.at || Date.now() + 3_600_000).split('T')
    setDate(day); setTime(hour); setError(''); setSelected(item.id)
  }
  useEffect(() => {
    if (selected && !job) setSelected(undefined)
    if (selected) return
    const waiting = jobs.find(item => item.at === null && !dismissed.current.has(item.id))
    if (waiting) open(waiting)
  }, [jobs, job, selected])

  const close = () => {
    if (saving) return
    if (job) dismissed.current.add(job.id)
    setSelected(undefined)
  }
  const choose = async (now: boolean) => {
    if (!job || saving) return
    const chosen = date + 'T' + time
    const at = now ? 0 : new Date(chosen).getTime()
    if (!now && (!Number.isFinite(at) || at <= Date.now() || localTime(at) !== chosen)) {
      setError(t('Choose a valid date and time in the future.'))
      return
    }
    setSaving(true); setError('')
    try {
      if (!await window.yogurt.processing.choose(job.id, at)) {
        setError(t("Yogurt couldn't save the processing time."))
        return
      }
      dismissed.current.add(job.id)
      setSelected(undefined)
    } catch {
      setError(t("Yogurt couldn't save the processing time."))
    } finally {
      setSaving(false)
    }
  }
  return <>
    {jobs.length > 0 && <label className="no-drag">
      <span className="sr-only">{t('Scheduled processing')}</span>
      <select value={selected ?? ''} onChange={e => {
        const item = jobs.find(candidate => candidate.id === e.target.value)
        if (item) open(item)
      }}>
        <option value="" disabled>{t('Scheduled processing')}</option>
        {jobs.map(item => <option key={item.id} value={item.id}>
          {item.title}{item.at ? ' · ' + new Date(item.at).toLocaleString() : ''}
        </option>)}
      </select>
    </label>}
    {job && <Modal title={t('Transcribe and summarize')} onCancel={close} busy={saving} testId="processing-schedule">
      <p>{job.title}</p>
      <p className="modal-copy">{t('Choose when Yogurt should process this recording. Keep Yogurt open and your computer awake for it to start on time.')}</p>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1">{t('Date')}
          <input className="p-2" type="date" min={localTime(Date.now()).split('T')[0]} value={date} onChange={e => setDate(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">{t('Time')}
          <input className="p-2" type="time" value={time} onChange={e => setTime(e.target.value)} />
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="modal-actions">
        <button className="modal-button" type="button" data-dialog-cancel disabled={saving} onClick={close}>{t('Decide later')}</button>
        <button className="modal-button" type="button" disabled={saving} onClick={() => void choose(true)}>{t('Process now')}</button>
        <button className="modal-button primary" type="button" disabled={saving} onClick={() => void choose(false)}>{t('Schedule')}</button>
      </div>
    </Modal>}
  </>
}
