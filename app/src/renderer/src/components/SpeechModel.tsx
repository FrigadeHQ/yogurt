import { useEffect, useState } from 'react'
import { ChevronDown } from './Icons'
import { retryToast, toasts } from './TrashToast'
import { language, t } from '../../../shared/i18n'
import { OWN_SPEECH_FILE, type SetupState, type SpeechModels } from '../../../shared/types'

const size = (bytes: number) => new Intl.NumberFormat(language(), { style: 'unit', unit: 'megabyte', unitDisplay: 'short', maximumFractionDigits: 0 }).format(bytes / 1e6)
const percent = (fraction: number) => new Intl.NumberFormat(language(), { style: 'percent', maximumFractionDigits: 0 }).format(fraction)

/** the select's entry that opens the file dialog; it is never the value shown */
const CHOOSE_FILE = 'choose-file'

/**
 * Settings → Transcription: Auto (the pick for this computer), one speech model, or a whisper.cpp file of the person's
 * own; a new one downloads (a file of their own does not), then takes over
 */
export function SpeechModel() {
  const [speech, setSpeech] = useState<SpeechModels>()
  const [setup, setSetup] = useState<SetupState>()
  /** what was wrong with the file just chosen */
  const [fileError, setFileError] = useState<'unreadable' | 'not-whisper' | 'yogurt-model'>()
  useEffect(() => {
    let current = false, active = true
    const off = window.yogurt.setup.onState((state) => { current = true; setSetup(state) })
    void window.yogurt.setup.state().then((state) => { if (active && !current) setSetup(state) })
    return () => { active = false; off() }
  }, [])
  // again when the model in use changes, and back from elsewhere (the Finder): the person's own file may have been moved
  useEffect(() => {
    if (setup?.phase !== 'ready') return
    const load = () => void window.yogurt.setup.speechModels().then(setSpeech)
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [setup?.phase, setup?.speechModel, setup?.speechFileGone])
  if (!speech) return null
  const pick = (id: string | null) => {
    toasts.close('speech-model-retry-error')
    setFileError(undefined)
    window.yogurt.setup.setSpeechModel(id)
      .then(() => window.yogurt.setup.speechModels()).then(setSpeech)
      .catch(() => retryToast('speech-model-retry-error', t("Couldn't save your changes"), 'speech-model-retry', async () => pick(id)))
  }
  const chooseFile = () => {
    toasts.close('speech-model-retry-error')
    window.yogurt.setup.chooseSpeechFile()
      .then((r) => { setFileError(r.ok || r.error === 'cancelled' ? undefined : r.error); return window.yogurt.setup.speechModels() }).then(setSpeech)
      .catch(() => retryToast('speech-model-retry-error', t("Couldn't save your changes"), 'speech-model-retry', async () => chooseFile()))
  }
  const name = (id?: string) => id === OWN_SPEECH_FILE ? speech.file?.name ?? '' : speech.models.find((m) => m.id === id)?.name ?? ''
  const note = fileError === 'not-whisper' ? t("That file isn't a Whisper model for whisper.cpp (a ggml .bin file).")
    : fileError === 'yogurt-model' ? t("That file is one of Yogurt's own models. Pick it from the list instead.")
    : fileError ? t("Yogurt can't read that file.")
    : setup?.speechSwitch ? t('Downloading {name} · {percent}', { name: name(setup.speechSwitch.id), percent: percent(setup.speechSwitch.fraction) })
    : setup?.speechSwitchPending ? t('{name} takes over once nothing is being transcribed.', { name: name(setup.speechSwitchPending) })
    : setup?.speechSwitchError ? t("Couldn't download it. {error}", { error: setup.speechSwitchError })
    : setup?.speechModel === OWN_SPEECH_FILE ? t("Transcribing with your own file, {name}. Yogurt hasn't checked how well it works.", { name: name(OWN_SPEECH_FILE) })
    : setup?.speechModel ? t('Transcribing with {name}.', { name: name(setup.speechModel) }) : ''
  const gone = setup?.speechFileGone ? t('{name} was moved, deleted or changed, so Yogurt went back to Auto.', { name: setup.speechFileGone }) : ''
  return (
    <div className="settings-row" data-testid="settings-speech-model">
      <div className="settings-row-copy">
        <label htmlFor="settings-speech" className="settings-label">{t('Transcription')}</label>
        <p id="settings-speech-description" data-testid="settings-speech-status" role="status" className="settings-description">{[t('Always on this computer.'), gone, note].filter(Boolean).join(' ')}</p>
      </div>
      <span className="settings-select-wrap">
        <select id="settings-speech" data-testid="settings-speech" aria-describedby="settings-speech-description" value={speech.file ? OWN_SPEECH_FILE : speech.choice ?? 'auto'} className="settings-select"
          onChange={(e) => {
            const v = e.target.value
            if (v === CHOOSE_FILE) chooseFile()
            else if (v !== OWN_SPEECH_FILE) pick(v === 'auto' ? null : v)
          }}>
          <option value="auto">{speech.auto ? t('Auto ({name})', { name: speech.auto.name }) : t('Auto')}</option>
          {speech.models.map((m) => <option key={m.id} value={m.id}>{`${m.name} · ${size(m.bytes)}`}</option>)}
          {speech.file && <option value={OWN_SPEECH_FILE}>{t('Your own file: {name} · {size}', { name: speech.file.name, size: size(speech.file.bytes) })}</option>}
          <option value={CHOOSE_FILE}>{t('Choose a file…')}</option>
        </select>
        <ChevronDown size={14} aria-hidden="true" />
      </span>
    </div>
  )
}
