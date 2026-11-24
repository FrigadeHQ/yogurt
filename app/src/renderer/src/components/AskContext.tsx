import { useContext } from 'react'
import { WorkspaceFolders } from '../folders'
import { ChevronDown, FileText } from './Icons'
import type { ContextTarget } from '../../../shared/askContext'
import { DEFAULT_FOLDER_APPEARANCE } from '../../../shared/folderAppearance'
import { FolderGlyph } from './FolderAppearance'
import { compactCount, tx } from '../i18n'
import { moreItems, t } from '../../../shared/i18n'

export const chipTitle = (c: ContextTarget) => c.title.trim() || (c.kind === 'meeting' ? t('Untitled meeting') : t('Folder'))
export const scopeLabel = (chips: ContextTarget[]) => ({
  name: chips.length ? chipTitle(chips[0]) : t('All meetings'),
  others: chips.length > 1 ? moreItems(chips.length - 1) : '',
})

export function ContextIcon({ target }: { target: ContextTarget }) {
  const folders = useContext(WorkspaceFolders)
  if (target.kind === 'meeting') return <FileText size={14} aria-hidden="true" />
  const folder = folders?.find(item => item.id === target.id)
  return <FolderGlyph appearance={folder ?? DEFAULT_FOLDER_APPEARANCE} size={14} />
}

export function AskContext({ chips }: { chips: ContextTarget[] }) {
  const name = chips.length ? chipTitle(chips[0]) : t('All meetings')
  return <>{chips[0] && <ContextIcon target={chips[0]} />}<span className="ask-scope-label"><span className="ask-scope-name">{name}</span>
    {chips.length > 1 && <span className="ask-scope-others"> {compactCount(chips.length - 1)}</span>}</span><ChevronDown size={12} aria-hidden="true" /></>
}


export function AnswerScope({ chips }: { chips: ContextTarget[] }) {
  const label = scopeLabel(chips)
  return <>
    <span aria-hidden="true">·</span>
    <span className="chat-answer-scope" title={chips.length ? chips.map(chipTitle).join('\n') : label.name}>
      {chips.length ? tx('Searched {name}', { name: <span className="ask-scope-label"><bdi className="ask-scope-name">{label.name}</bdi>
        {label.others && <span className="ask-scope-others">{` ${label.others}`}</span>}</span> }) : <span className="ask-scope-name">{t('Searched all meetings')}</span>}
    </span>
  </>
}
