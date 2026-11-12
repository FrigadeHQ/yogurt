import { useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { t } from '../../../shared/i18n'
import { addNickname, MAX_NICKNAME, MAX_NICKNAMES } from '../../../shared/mentions'

/**
 * Settings → General: a notification when someone in the call says your name, with what was said just before.
 * The other names people call you are added like personal jargon: Enter adds, Backspace in the empty field takes the last one off.
 * A plain row of the General group (its loading covers this one too), given what Settings read.
 */
export function MentionSetting({ initial }: { initial?: { on: boolean; names: string[] } }) {
  const [own, setS] = useState<{ on: boolean; names: string[] }>()
  const s = own ?? initial
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const toggle = () => { if (!s) return; const on = !s.on; setS({ ...s, on }); void window.yogurt.settings.setMentionAlerts(on) }
  // main cleans the list the same way, so what is shown is what is saved
  const save = (names: string[]) => { if (!s) return; setS({ ...s, names }); void window.yogurt.settings.setNicknames(names) }
  const names = s?.names ?? []
  const next = addNickname(names, text)
  const fresh = next !== names
  const full = names.length >= MAX_NICKNAMES
  const add = () => {
    if (fresh) save(next)
    if (fresh || (text.trim() && !full)) setText('')
    input.current?.focus()
  }
  const keys = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); add() }
    else if (e.key === 'Escape' && text) { e.preventDefault(); setText('') }
    else if (e.key === 'Backspace' && !text && names.length) { e.preventDefault(); save(names.slice(0, -1)) }
  }
  const label = t('Tell me when someone says my name')
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <p className="settings-label">{label}</p>
        <p className="settings-description">{t('A notification shows the last few things said, so you can jump back in.')}</p>
        {s?.on && (
          <>
            <label htmlFor="nickname-input" className="settings-description mt-3 block">{t('Other names people call you')}</label>
            <div data-testid="nickname-field" className="settings-jargon-field" onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); input.current?.focus() } }}>
              {names.map((n) => (
                <span key={n.toLowerCase()} data-testid="nickname-chip" className="settings-jargon-chip">
                  <span dir="auto">{n}</span>
                  <button type="button" aria-label={t('Remove {name}', { name: n })} onClick={() => { save(names.filter((x) => x !== n)); input.current?.focus() }} className="settings-jargon-remove">
                    <X size={12} aria-hidden="true" />
                  </button>
                </span>
              ))}
              <input ref={input} id="nickname-input" data-testid="nickname-input" value={text} maxLength={MAX_NICKNAME + 20} autoComplete="off" spellCheck={false}
                role="combobox" aria-expanded={fresh} aria-controls="nickname-suggestions" aria-autocomplete="list" aria-activedescendant={fresh ? 'nickname-suggest' : undefined}
                placeholder={full ? t('Your list is full. Remove a name to add another.') : t('Add a name and press Enter')}
                onChange={(e) => setText(e.target.value)} onKeyDown={keys} className="settings-jargon-input" />
              <ul id="nickname-suggestions" role="listbox" aria-label={t('Other names people call you')} hidden={!fresh} className="settings-jargon-suggest">
                {fresh && (
                  <li id="nickname-suggest" data-testid="nickname-suggest" role="option" aria-selected="true" onMouseDown={(e) => e.preventDefault()} onClick={add} className="settings-jargon-option">
                    <Plus size={14} aria-hidden="true" className="shrink-0 text-muted" />
                    <span dir="auto" className="truncate">{t('Add "{term}"', { term: next.at(-1)! })}</span>
                  </li>
                )}
              </ul>
            </div>
          </>
        )}
      </div>
      {/* level with the label: the row grows with the names under it */}
      <button data-testid="mention-toggle" role="switch" aria-checked={!!s?.on} aria-label={label} onClick={toggle} disabled={!s} className="settings-toggle self-start">
        <span className="settings-toggle-knob" />
      </button>
    </div>
  )
}
