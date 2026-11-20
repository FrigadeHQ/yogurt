import { useContext } from 'react'
import { WorkspaceFolders } from '../folders'
import { ChevronDown, FileText } from 'lucide-react'
import type { ContextTarget } from '../../../shared/askContext'
import { DEFAULT_FOLDER_APPEARANCE } from '../../../shared/folderAppearance'
import { FolderGlyph } from './FolderAppearance'
import { tx } from '../i18n'
import { t } from '../../../shared/i18n'

export const chipTitle = (c: ContextTarget) => c.title.trim() || (c.kind === 'meeting' ? t('Untitled meeting') : t('Folder'))
export const scopeLabel = (chips: ContextTarget[]) => ({
  name: chips.length ? chipTitle(chips[0]) : t('All meetings'),
  others: chips.length > 1 ? t('and {count} others', { count: chips.length - 1 }) : '',
})

export function ContextIcon({ target }: { target: ContextTarget }) {
  const folders = useContext(WorkspaceFolders)
  if (target.kind === 'meeting') return <FileText size={14} aria-hidden="true" />
  const folder = folders?.find(item => item.id === target.id)
  return <FolderGlyph appearance={folder ?? DEFAULT_FOLDER_APPEARANCE} size={14} />
}

export function AskContext({ chips }: { chips: ContextTarget[] }) {
  const label = scopeLabel(chips)
  return <>{chips[0] && <ContextIcon target={chips[0]} />}<span className="ask-scope-label"><span className="ask-scope-name">{label.name}</span>
    {label.others && <span className="ask-scope-others">{` ${label.others}`}</span>}</span><ChevronDown size={12} aria-hidden="true" /></>
}


export function AnswerScope({ chips }: { chips: ContextTarget[] }) {
  const label = scopeLabel(chips)
  return <span className="chat-answer-scope" title={chips.length ? chips.map(chipTitle).join('\n') : label.name}>
    {chips.length ? tx('Searched {name}', { name: <span className="ask-scope-label"><span className="ask-scope-name">{label.name}</span>
      {label.others && <span className="ask-scope-others">{` ${label.others}`}</span>}</span> }) : t('Searched all meetings')}
  </span>
}
