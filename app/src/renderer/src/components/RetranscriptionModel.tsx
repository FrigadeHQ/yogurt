import { useEffect, useState } from 'react'
import { t } from '../../../shared/i18n'
import type { RetranscriptionModel } from '../../../shared/transcription'
import { Modal } from './Modal'

export function RetranscriptionModelDialog({ onRun, onClose }: {
  onRun: (model?: string) => Promise<boolean>
  onClose: () => void
}) {
  const [models, setModels] = useState<RetranscriptionModel[]>([])
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    void window.yogurt.transcript.models().then(list => { if (active) setModels(list) }, () => {})
    return () => { active = false }
  }, [])

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setFailed(false)
    try {
      if (await onRun(model || undefined)) onClose()
      else setFailed(true)
    } catch { setFailed(true) }
    finally { setBusy(false) }
  }

  return <Modal title={t('Transcribe again')} onCancel={onClose} busy={busy} testId="retranscription-model-dialog">
    <form onSubmit={event => { event.preventDefault(); void submit() }}>
      <label className="flex flex-col gap-1.5 text-sm">
        {t('Whisper model')}
        <select data-testid="retranscription-model" value={model} disabled={busy}
          className="w-full rounded-lg border border-line bg-bg px-2.5 py-2 text-ink" onChange={event => setModel(event.target.value)}>
          <option value="">{t('Auto')}</option>
          {models.map(option => <option key={option.id} value={option.id}>
            {option.name}{option.downloaded ? '' : ` · ${Math.round(option.bytes / 1e6)} MB`}
          </option>)}
        </select>
      </label>
      {failed && <p role="alert" className="mt-2 text-sm text-danger">{t("Yogurt couldn't transcribe this file.")}</p>}
      <div className="modal-actions">
        <button type="button" data-dialog-cancel disabled={busy} onClick={onClose} className="workspace-button">{t('Cancel')}</button>
        <button type="submit" disabled={busy} className="modal-button primary">{t('Transcribe again')}</button>
      </div>
    </form>
  </Modal>
}
