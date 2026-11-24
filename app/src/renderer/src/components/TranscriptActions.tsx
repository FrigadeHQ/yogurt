import { Menu } from '@base-ui/react/menu'
import { useEffect, useRef, useState } from 'react'
import { t } from '../../../shared/i18n'
import { clock, transcriptSpeaker } from '../../../shared/transcript'
import type { Segment } from '../../../shared/types'
import type { TranscriptChange } from '../../../shared/transcriptEdit'
import type { CommitTranscript } from './TranscriptWording'
import { toasts } from './TrashToast'

type Line = Omit<Segment,'id'> & { id?: number }
type Range = { revision: number; ids: Set<number>; anchor?: number; opener: HTMLElement }
type MenuAt = { line: Line; button: HTMLElement; block: number[]; revision: number }

/** Selection holds the revision shown in the preview, even when another window refreshes the rows. */
export function useTranscriptActions(id: string, revision: number, lines: Line[], hasRemoved: boolean, audio: boolean, commit: CommitTranscript) {
  const [menu, setMenu] = useState<MenuAt>(), [range,setRange] = useState<Range>()
  const [recover,setRecover] = useState(false), [reload,setReload] = useState(0)
  const [removed,setRemoved] = useState<Array<Segment & {batch:string}>>([])
  const [readFailed,setReadFailed] = useState(false)
  const recoveryButton = useRef<HTMLButtonElement>(null), cancel = useRef<HTMLButtonElement>(null)
  const busy = useRef(false)
  useEffect(() => { setRange(undefined); setMenu(undefined); setRecover(false) }, [id])
  useEffect(() => {
    let active = true
    if (!recover) { setRemoved([]); return }
    setReadFailed(false)
    window.yogurt.transcript.removed(id).then(rows => { if (active) setRemoved(rows) }, () => { if (active) setReadFailed(true) })
    return () => { active = false }
  },[id,recover,revision,reload])
  useEffect(() => { if(range) cancel.current?.focus() },[!!range])
  const closeRange = () => { setRange(undefined); range?.opener.focus({preventScroll:true}) }
  const apply = async (at: number, change: TranscriptChange) => {
    if (busy.current) return
    busy.current = true
    try {
      const result = await commit(at,change)
      if (result.status === 'stale') {
        toasts.add({ title:t('The transcript changed. Select the lines again.') }); closeRange(); return
      }
      if (result.status !== 'saved' && result.status !== 'unchanged') throw new Error('Transcript unavailable')
      if (change.kind === 'remove') {
        const ids = new Set(change.ids), index = lines.findIndex(l => ids.has(l.id!))
        const next = lines.slice(index).find(l => !ids.has(l.id!)) ?? lines.slice(0,index).at(-1)
        setRange(undefined)
        requestAnimationFrame(() => (next ? document.querySelector<HTMLElement>(`[data-key="${next.id}"]`) : recoveryButton.current)?.focus())
      }
    } catch {
      toasts.add({ id:'transcript-change-error',title:t('Couldn’t save the transcript change.'),timeout:0,
        actionProps:{ children:t('Try again'), onClick:() => { toasts.close('transcript-change-error'); void apply(at,change) } } })
    } finally { busy.current = false }
  }
  const openMenu = (line: Line, button: HTMLElement) => {
    const block = [...button.closest('[data-testid="transcript-bubble"]')!.querySelectorAll<HTMLElement>('[data-key]')].map(row => Number(row.dataset.key))
    setMenu({line,button,block,revision})
  }
  const choose = (row: number, extend: boolean) => {
    setRange(prev => {
      if (!prev) return prev
      const ids = new Set(prev.ids)
      if (extend && prev.anchor !== undefined) {
        const a = lines.findIndex(l => l.id === prev.anchor), b = lines.findIndex(l => l.id === row)
        for (const l of lines.slice(Math.min(a,b),Math.max(a,b)+1)) ids.add(l.id!)
      } else if (ids.has(row)) ids.delete(row)
      else ids.add(row)
      return {...prev,ids,anchor:extend ? prev.anchor ?? row : row}
    })
  }
  const selected = range && lines.filter(l => range.ids.has(l.id!))
  const toolbar = <>
    {!!lines.length && <button className="ghost-btn transcript-tool" aria-pressed={!!range} onClick={e => range ? closeRange() : setRange({ids:new Set(),revision,opener:e.currentTarget})}>{t('Select lines')}</button>}
    {(hasRemoved || recover) && <button ref={recoveryButton} className="ghost-btn transcript-tool" aria-expanded={recover} onClick={() => setRecover(!recover)}>{recover ? t('Hide removed lines') : t('Show removed lines')}</button>}
  </>
  const batches = new Map<string, typeof removed>()
  for (const row of removed) {
    if (!batches.has(row.batch)) batches.set(row.batch,[])
    batches.get(row.batch)!.push(row)
  }
  const panel = <>
    {range && selected && <div className="transcript-preview" onKeyDown={e => {if(e.key==='Escape'){e.stopPropagation();closeRange()}}}>
      <span role="status">{t('{count} lines selected',{count:selected.length})}{selected.length > 0 && ` · ${clock(selected[0].startMs)}–${clock(selected.reduce((last,l) => Math.max(last,l.endMs),0))}`}</span>
      {audio && <span className="text-muted">{t('You’ll still hear these lines in the recording.')}</span>}
      <button className="workspace-button primary" disabled={!selected.length} onClick={() => void apply(range.revision,{kind:'remove',ids:[...range.ids]})}>{t('Remove from transcript')}</button>
      <button ref={cancel} className="ghost-btn" onClick={closeRange}>{t('Cancel')}</button>
    </div>}
    {recover && <section className="transcript-recovery" aria-label={t('Show removed lines')}>
      {readFailed && <button onClick={() => setReload(n=>n+1)}>{t('Try again')}</button>}
      {[...batches].map(([batch,rows]) => <div key={batch} className="transcript-batch">
        {rows.map(row => <p key={row.id}><time>{clock(row.startMs)}</time> <b>{transcriptSpeaker(row)}</b> {row.text}</p>)}
        <button className="workspace-button" onClick={() => void apply(revision,{kind:'restore',batch})}>{t('Restore lines')}</button>
      </div>)}
      {batches.size > 0 && <button className="ghost-btn" onClick={() => void apply(revision,{kind:'restore',batch:null})}>{t('Restore all lines')}</button>}
    </section>}
    {menu && <Menu.Root open modal={false} onOpenChange={open=>{if(!open)setMenu(undefined)}}>
      <Menu.Portal><Menu.Positioner anchor={menu.button} sideOffset={4} align="end" className="ask-menu-positioner">
        <Menu.Popup className="menu-entry ask-actions-menu" finalFocus={() => menu.button} aria-label={t('Transcript actions at {time}',{time:clock(menu.line.startMs)})}>
          <span className="transcript-menu-time">{clock(lines.find(l=>l.id===menu.block[0])?.startMs ?? menu.line.startMs)}–{clock(lines.filter(l=>menu.block.includes(l.id!)).reduce((end,l)=>Math.max(end,l.endMs),0))}</span>
          <Menu.Item onFocus={()=>menu.button.closest('[data-testid="transcript-bubble"]')?.setAttribute('data-remove-focus','true')}
            onBlur={()=>menu.button.closest('[data-testid="transcript-bubble"]')?.removeAttribute('data-remove-focus')}
            onClick={()=>void apply(menu.revision,{kind:'remove',ids:menu.block})}>{t('Remove block')}</Menu.Item>
          <Menu.Item onClick={()=>setRange({ids:new Set(lines.slice(0,lines.findIndex(l=>l.id===menu.line.id)).map(l=>l.id!)),revision:menu.revision,opener:menu.button})}>{t('Remove earlier lines…')}</Menu.Item>
          {menu.line.corrected && <Menu.Item onClick={()=>void apply(menu.revision,{kind:'original',id:menu.line.id!,expected:menu.line.text})}>{t('Restore original wording')}</Menu.Item>}
        </Menu.Popup>
      </Menu.Positioner></Menu.Portal>
    </Menu.Root>}
  </>
  return { toolbar, panel, openMenu, range, choose, closeRange, recoveryButton }
}
