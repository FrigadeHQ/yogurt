import { useEffect, useState } from 'react'
import { ChevronDown } from './Icons'
import { retryToast, toasts } from './TrashToast'
import { language, t } from '../../../shared/i18n'
import type { SetupState, SpeechModels } from '../../../shared/types'

const size = (bytes: number) => new Intl.NumberFormat(language(), { style: 'unit', unit: 'megabyte', unitDisplay: 'short', maximumFractionDigits: 0 }).format(bytes / 1e6)
const percent = (fraction: number) => new Intl.NumberFormat(language(), { style: 'percent', maximumFractionDigits: 0 }).format(fraction)

/** Settings → Transcription: Auto (the pick for this computer) or one speech model; a new one downloads, then takes over */
export function SpeechModel() {
  const [speech, setSpeech] = useState<SpeechModels>()
  const [setup, setSetup] = useState<SetupState>()
  useEffect(() => {
    let current = false, active = true
    const off = window.yogurt.setup.onState((state) => { current = true; setSetup(state) })
    void window.yogurt.setup.state().then((state) => { if (active && !current) setSetup(state) })
    return () => { active = false; off() }
  }, [])
  useEffect(() => { if (setup?.phase === 'ready') void window.yogurt.setup.speechModels().then(setSpeech) }, [setup?.phase])
  if (!speech) return null
  const pick = (id: string | null) => {
    toasts.close('speech-model-retry-error')
    window.yogurt.setup.setSpeechModel(id)
      .then(() => window.yogurt.setup.speechModels()).then(setSpeech)
      .catch(() => retryToast('speech-model-retry-error', t("Couldn't save your changes"), 'speech-model-retry', async () => pick(id)))
  }
  const name = (id?: string) => speech.models.find((m) => m.id === id)?.name ?? ''
  const note = setup?.speechSwitch ? t('Downloading {name} · {percent}', { name: name(setup.speechSwitch.id), percent: percent(setup.speechSwitch.fraction) })
    : setup?.speechSwitchPending ? t('{name} takes over once nothing is being transcribed.', { name: name(setup.speechSwitchPending) })
    : setup?.speechSwitchError ? t("Couldn't download it. {error}", { error: setup.speechSwitchError })
    : setup?.speechModel ? t('Transcribing with {name}.', { name: name(setup.speechModel) }) : ''
  return (
    <div className="settings-row" data-testid="settings-speech-model">
      <div className="settings-row-copy">
        <label htmlFor="settings-speech" className="settings-label">{t('Transcription')}</label>
        <p id="settings-speech-description" data-testid="settings-speech-status" role="status" className="settings-description">{[t('Always on this computer.'), note].filter(Boolean).join(' ')}</p>
      </div>
      <span className="settings-select-wrap">
        <select id="settings-speech" data-testid="settings-speech" aria-describedby="settings-speech-description" value={speech.choice ?? 'auto'} className="settings-select"
          onChange={(e) => pick(e.target.value === 'auto' ? null : e.target.value)}>
          <option value="auto">{speech.auto ? t('Auto ({name})', { name: speech.auto.name }) : t('Auto')}</option>
          {speech.models.map((m) => <option key={m.id} value={m.id}>{`${m.name} · ${size(m.bytes)}`}</option>)}
        </select>
        <ChevronDown size={14} aria-hidden="true" />
      </span>
    </div>
  )
}
