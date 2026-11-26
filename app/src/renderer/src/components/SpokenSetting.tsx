import { spokenName } from './SpokenMenu'
import { LoadingContent } from './LoadingContent'
import { useEffect, useState } from 'react'
import { Languages } from './Icons'
import { SPOKEN, type Spoken } from '../../../shared/spoken'
import { t } from '../../../shared/i18n'

const label = (s: Spoken) => (s === 'en' ? t('English only') : spokenName(s))

/** Settings → Language: the language people speak in meetings, the same choice as the picker under a note */
export function SpokenSetting() {
  const [spoken, setSpoken] = useState<Spoken>()
  useEffect(() => { void window.yogurt.settings.get().then((p) => setSpoken(p.spoken)) }, [])
  const choose = (v: Spoken) => { setSpoken(v); void window.yogurt.settings.setSpoken(v) }
  const arrows = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl'
    const step = { ArrowDown: 1, ArrowUp: -1, ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[e.key]
    if (!step) return
    e.preventDefault()
    const next = SPOKEN[(SPOKEN.indexOf(spoken ?? 'en') + step + SPOKEN.length) % SPOKEN.length]
    choose(next)
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-spoken-choice="${next}"]`)?.focus()
  }
  return (
    <LoadingContent pending={!spoken}><div className="settings-row" data-kind="spoken">
      <span className="settings-permission-icon"><Languages size={17} aria-hidden="true" /></span>
      <div className="settings-row-copy">
        <p className="settings-label">{t('Spoken language')}</p>
      </div>
      <div role="radiogroup" aria-label={t('Spoken language')} onKeyDown={arrows} className="settings-spoken">
        {SPOKEN.map((v) => (
          <button key={v} data-testid={`settings-spoken-${v}`} data-spoken-choice={v} role="radio" aria-checked={spoken === v} tabIndex={(spoken ?? 'en') === v ? 0 : -1} onClick={() => choose(v)}
            className="settings-spoken-choice">{label(v)}</button>
        ))}
      </div>
    </div></LoadingContent>
  )
}
