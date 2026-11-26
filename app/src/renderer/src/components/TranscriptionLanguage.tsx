import { useState } from 'react'
import { t } from '../../../shared/i18n'
import { isTranscriptionLanguage, SAVED_TRANSCRIPTION_LANGUAGES, type TranscriptionLanguage } from '../../../shared/spoken'
import { Modal } from './Modal'

const languages = SAVED_TRANSCRIPTION_LANGUAGES.map(code => ({
  code,
  name: new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code,
})).sort((a, b) => a.name.localeCompare(b.name))

export function TranscriptionLanguageField({ value, onChange, disabled }: {
  value?: TranscriptionLanguage; onChange: (value?: TranscriptionLanguage) => void; disabled?: boolean
}) {
  return <label className="flex flex-col gap-1.5 text-sm">
    {t('Spoken language')}
    <select data-testid="transcription-language" value={value ?? ''} disabled={disabled}
      className="w-full rounded-lg border border-line bg-bg px-2.5 py-2 text-ink"
      onChange={event => {
        const language = event.target.value
        onChange(isTranscriptionLanguage(language) ? language : undefined)
      }}>
      <option value="">{t('Default')}</option>
      <option value="auto">{t('Multi-language')}</option>
      {languages.map(({ code, name }) => <option key={code} value={code}>{name}</option>)}
    </select>
  </label>
}

export function TranscriptionLanguageDialog({ title, initial, onRun, onClose }: {
  title: string; initial?: TranscriptionLanguage; onRun: (language: TranscriptionLanguage | null) => Promise<boolean>; onClose: () => void
}) {
  const [language, setLanguage] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const submit = async () => {
    if (busy) return
    setBusy(true)
    setFailed(false)
    try {
      if (await onRun(language ?? null)) onClose()
      else setFailed(true)
    } catch { setFailed(true) }
    finally { setBusy(false) }
  }
  return <Modal title={title} onCancel={onClose} busy={busy} testId="transcription-language-dialog">
    <form onSubmit={event => { event.preventDefault(); void submit() }}>
      <TranscriptionLanguageField value={language} onChange={setLanguage} disabled={busy} />
      {failed && <p role="alert" className="mt-2 text-sm text-danger">{t("Yogurt couldn't transcribe this file.")}</p>}
      <div className="modal-actions">
        <button type="button" data-dialog-cancel disabled={busy} onClick={onClose} className="workspace-button">{t('Cancel')}</button>
        <button type="submit" disabled={busy} className="modal-button primary">{title}</button>
      </div>
    </form>
  </Modal>
}
