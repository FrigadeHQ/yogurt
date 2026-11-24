import { useLayoutEffect, useRef, useState } from 'react'
import type { EditResult, TranscriptChange } from '../../../shared/transcriptEdit'
import { t } from '../../../shared/i18n'

export type CommitTranscript = (revision: number, change: TranscriptChange) => Promise<EditResult>
type Draft = { expected: string; revision: number }

export function TranscriptWording({ id, text, revision, commit, onEditing }: {
  id: number; text: string; revision: number; commit: CommitTranscript; onEditing: (id?: number) => void
}) {
  const surface = useRef<HTMLSpanElement>(null), draft = useRef<Draft | null>(null)
  const busy = useRef(false), owner = useRef(false)
  const [issue, setIssue] = useState<'empty' | 'failed' | 'conflict'>()
  const current = useRef(text)
  current.current = text
  useLayoutEffect(() => { if (!draft.current && surface.current) surface.current.textContent = text }, [text])
  const row = () => surface.current?.closest<HTMLElement>('[data-key]')
  const close = (words: string, focus: boolean) => {
    const el = surface.current
    if (!el) return
    draft.current = null; owner.current = false
    el.contentEditable = 'false'; el.textContent = words
    setIssue(undefined); onEditing(undefined)
    if (focus) row()?.focus({ preventScroll: true })
  }
  const enter = (pointer: boolean) => {
    const el = surface.current, sel = window.getSelection()
    if (!el || !sel || draft.current) return
    if (pointer && (!el.contains(sel.anchorNode) || !el.contains(sel.focusNode))) return
    const { anchorNode, anchorOffset, focusNode, focusOffset } = sel
    draft.current = { expected: current.current, revision }
    onEditing(id); el.contentEditable = 'plaintext-only'; el.focus({ preventScroll: true })
    if (pointer && anchorNode && focusNode) sel.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset)
    else sel.collapse(el, el.childNodes.length)
  }
  const save = async (focus: boolean, remove = false) => {
    const active = draft.current, el = surface.current
    if (!el || !active || busy.current) return
    const words = (el.innerText ?? '').replace(/[\r\n]+/g, ' ')
    if (!remove && !words.trim()) { setIssue('empty'); return }
    if (!remove && words === active.expected) { close(words,focus); return }
    busy.current = true
    try {
      const result = await commit(active.revision, remove ? { kind: 'remove', ids: [id] } : { kind: 'wording', id, expected: active.expected, text: words })
      if (result.status === 'conflict') {
        active.expected = result.text; active.revision = result.revision; setIssue('conflict')
      } else if (result.status === 'saved' || result.status === 'unchanged') close(words,focus)
      else setIssue('failed')
    } catch { setIssue('failed') }
    finally { busy.current = false }
  }
  return <><span ref={surface} data-testid="transcript-text" data-editable="true" tabIndex={-1} suppressContentEditableWarning
    onPointerUp={() => enter(true)} onFocus={() => { if (!draft.current) enter(false) }}
    onBlur={() => { if (!issue && !owner.current) void save(false) }}
    onBeforeInput={e => { if (busy.current) e.preventDefault() }}
    onPaste={e => {
      if (!draft.current) return
      e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/[\r\n]+/g, ' '))
    }}
    onKeyDown={e => {
      if (e.nativeEvent.isComposing) return
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!busy.current) close(current.current,true) }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void save(true) }
    }} />
    {issue && <span className="transcript-edit-message" role="alert" onPointerDown={() => { owner.current = true }}>
      {issue === 'empty' ? t('Remove this line?') : issue === 'conflict' ? draft.current?.expected : t('Couldn’t save the transcript change.')}
      <button className="workspace-button" onClick={() => void save(true, issue === 'empty')}>{issue === 'empty' ? t('Remove line') : issue === 'conflict' ? t('Use my wording') : t('Try again')}</button>
      <button className="ghost-btn" onClick={() => close(draft.current?.expected ?? current.current,true)}>{issue === 'conflict' ? t('Keep saved wording') : t('Cancel')}</button>
    </span>}
  </>
}
