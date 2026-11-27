import { LoadingContent } from './LoadingContent'
import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Languages } from './Icons'
import { pickableLanguages, type Spoken } from '../../../shared/spoken'
import { language, t } from '../../../shared/i18n'

/** Settings → Language: the language people speak in meetings, the same choice as the picker under a note */
export function SpokenSetting() {
  const [spoken, setSpoken] = useState<Spoken>()
  useEffect(() => { void window.yogurt.settings.get().then((p) => setSpoken(p.spoken)) }, [])
  const choose = (v: Spoken) => { setSpoken(v); void window.yogurt.settings.setSpoken(v) }
  const ui = language()
  const languages = useMemo(() => pickableLanguages(ui), [ui])
  return (
    <LoadingContent pending={!spoken}><div className="settings-row">
      <span className="settings-permission-icon"><Languages size={17} aria-hidden="true" /></span>
      <div className="settings-row-copy">
        <label htmlFor="settings-spoken" className="settings-label">{t('Spoken language')}</label>
        <p id="settings-spoken-description" className="settings-description">{t('Pick the language of your meetings for the most accurate transcript. Multi-language is for meetings that mix languages.')}</p>
      </div>
      <span className="settings-select-wrap">
        <select id="settings-spoken" data-testid="settings-spoken" aria-describedby="settings-spoken-description" value={spoken ?? 'en'} disabled={!spoken} onChange={(e) => choose(e.target.value)} className="settings-select">
          <option value="en">{t('English only')}</option>
          <option value="multi">{t('Multi-language')}</option>
          <option disabled>──────────</option>
          {languages.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
        </select>
        <ChevronDown size={14} aria-hidden="true" />
      </span>
    </div></LoadingContent>
  )
}
