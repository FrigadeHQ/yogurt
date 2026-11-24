import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { AllSelection, EditorState, TextSelection } from '@tiptap/pm/state'
import { EditorView } from '@tiptap/pm/view'
import type { Segment } from '../../../shared/types'
import type { CommitTranscript, TranscriptChange } from '../../../shared/transcriptEdit'
import { command } from '../keys'
import { t } from '../../../shared/i18n'
import { documentChanges, documentLines, removeBlankLine, replacePassage, transcriptDocument } from '../transcriptDocument'

type Saved = { revision:number; lines:Segment[] }
type Issue = { kind:'failed' | 'reload' | 'stale' | 'conflict'; text?:string }
export type DocumentControls = { finish:() => Promise<boolean>; step:(direction:'undo' | 'redo') => Promise<void>; revert:(row:number | null,removed?:boolean)=>Promise<void> }

export function TranscriptDocument({id, initialLine, reviewing, saved, commit, controls, leave, onDirty}:{
  id:string; initialLine?:number; reviewing:boolean; saved:Saved; commit:CommitTranscript; controls:RefObject<DocumentControls | null>; leave:() => void; onDirty:(dirty:boolean)=>void
}) {
  const host = useRef<HTMLDivElement>(null)
  const props = useRef({saved,commit,leave,onDirty})
  props.current = {saved,commit,leave,onDirty}
  const sync = useRef<(saved:Saved) => void>(undefined)
  const resolveIssue = useRef<(useDraft:boolean) => void>(undefined)
  const [issue,setIssue] = useState<Issue>()
  const issueAlert = useRef<HTMLDivElement>(null)
  useLayoutEffect(()=>{ if (issue) issueAlert.current?.scrollIntoView({block:'nearest'}) },[issue])
  useLayoutEffect(() => {
    let base = props.current.saved, dirty = false, disposed = false
    const mark = (value:boolean) => {
      if (dirty!==value) { dirty=value; if (!disposed) props.current.onDirty(value) }
    }
    let problem:Issue | undefined, pending:Promise<boolean> | undefined
    let retryCommand:(() => Promise<void>) | undefined
    const report = (next?:Issue) => { problem = next; if (!disposed) setIssue(next) }
    const state = (doc:ReturnType<typeof transcriptDocument>, pos = 0) => EditorState.create({
      doc, selection:TextSelection.near(doc.resolve(Math.min(pos,doc.content.size))),
    })
    const refresh = (next:Saved, discard=false) => {
      if (disposed || (!discard && (pending || dirty || next.revision < base.revision))) return
      if (!discard && next.revision===base.revision && next.lines===base.lines) return
      base = next
      const doc = transcriptDocument(next.lines)
      if (!doc.eq(view.state.doc)) {
        const previous = view.state.selection
        const rows = documentLines(doc)
        const position = (point:typeof previous.$head) => {
          const row = rows.find(r=>r.id===point.parent.attrs.id)
          return doc.resolve(row ? row.start+Math.min(point.parentOffset,row.text.length) : Math.min(point.pos,doc.content.size))
        }
        const selection = previous instanceof AllSelection && view.state.doc.childCount>0 ? new AllSelection(doc) :
          TextSelection.between(position(previous.$anchor),position(previous.$head))
        view.updateState(EditorState.create({doc,selection}))
      }
      mark(false)
    }
    const save = async ():Promise<boolean> => {
      if (pending) return (await pending) && save()
      if (problem) return false
      if (!dirty) return true
      const rows = documentChanges(base.lines,view.state.doc)
      const cleared = new Set(rows.filter(r=>r.text!==null && !r.text.trim()).map(r=>r.id))
      if (cleared.size) {
        // An IME can leave a blank draft when focus moves before its final transaction.
        const tr = view.state.tr
        for (const row of documentLines(tr.doc).reverse()) if (cleared.has(row.id)) removeBlankLine(tr,row.start)
        view.updateState(view.state.apply(tr))
        for (const row of rows) if (cleared.has(row.id)) row.text=null
      }
      if (!rows.length) { mark(false); return true }
      const removed = rows.filter(r=>r.text===null)
      const change:TranscriptChange = removed.length===rows.length ? {kind:'remove',ids:removed.map(r=>r.id)} :
        rows.length===1 && rows[0].text!==null ? {kind:'wording',id:rows[0].id,expected:rows[0].expected,text:rows[0].text} : {kind:'selection',rows}
      const sent = view.state.doc
      const values = new Map(rows.map(r => [r.id,r.text]))
      pending = (async () => {
        try {
          const result = await props.current.commit(base.revision,change)
          if (result.status !== 'saved' && result.status !== 'unchanged') {
            report(result.status === 'conflict' ? {kind:'conflict',text:result.text} : {kind:result.status === 'stale' ? 'stale' : 'failed'})
            return false
          }
          base = {revision:result.status==='saved' ? result.revision : base.revision, lines:base.lines.flatMap(l =>
            values.has(l.id) ? (values.get(l.id) === null ? [] : [{...l,text:values.get(l.id)!}]) : [l])}
          mark(!view.state.doc.eq(sent))
          return true
        } catch { report({kind:'failed'}); return false }
      })()
      const ok = await pending
      pending = undefined
      if (ok) refresh(props.current.saved)
      return ok
    }
    const finish = async () => {
      do { if (!await save()) return false } while (dirty)
      return true
    }
    const perform = async (change:TranscriptChange) => {
      if (!await finish() || disposed || pending) return
      const reload = async ():Promise<void> => {
        try {
          const snapshot = await window.yogurt.transcript.snapshot(id)
          refresh({revision:snapshot.revision,lines:snapshot.lines.filter(l=>!l.hidden)})
        } catch { retryCommand=reload; report({kind:'reload'}) }
      }
      try {
        const result = await props.current.commit(base.revision,change)
        if (result.status==='saved') await reload()
        else if (result.status!=='unchanged') report({kind:'stale'})
      } catch { retryCommand=()=>run(change); report({kind:'failed'}) }
    }
    let commands = Promise.resolve()
    const run = (change:TranscriptChange) => {
      commands = commands.then(()=>perform(change))
      return commands
    }
    const replace = (value:string) => {
      if (problem || view.state.selection.empty) return false
      const next = replacePassage(view.state.doc,view.state.selection,value,base.lines)
      if (!next) return false
      view.updateState(EditorState.create({doc:next.doc,selection:next.selection}))
      mark(true)
      void save()
      return true
    }
    const syncSelection = () => {
      // A pointer selection is visible before Chromium delivers selectionchange to the editor.
      const native = view.dom.ownerDocument.getSelection()
      if (!native?.anchorNode || !native.focusNode || !view.hasFocus() ||
          !view.dom.contains(native.anchorNode) || !view.dom.contains(native.focusNode)) return
      const {doc,selection} = view.state
      const anchor = view.posAtDOM(native.anchorNode,native.anchorOffset)
      const head = view.posAtDOM(native.focusNode,native.focusOffset)
      if (anchor === selection.anchor && head === selection.head) return
      view.dispatch(view.state.tr.setSelection(TextSelection.between(doc.resolve(anchor),doc.resolve(head))))
    }
    const passage = (deleting:boolean) => {
      const {$from,$to,empty} = view.state.selection
      return !empty && (!$from.sameParent($to) || (deleting && $from.parentOffset===0 && $to.parentOffset===$to.parent.content.size))
    }
    const doc=transcriptDocument(base.lines)
    const initialPos=initialLine===undefined ? 0 : documentLines(doc).find(row=>row.id===initialLine)?.start
    const view:EditorView = new EditorView(host.current!, {
      state:state(doc,initialPos),
      attributes:{class:'transcript-document',role:'textbox','aria-multiline':'true','aria-label':t('Transcript'),'data-testid':'transcript-document',spellcheck:'true'},
      dispatchTransaction(tr) {
        // Native joins, splits and rich-text drops must never create or transfer an audio timestamp.
        let removed = false
        if (tr.docChanged) {
          const start = tr.before.content.findDiffStart(tr.doc.content)
          const end = tr.before.content.findDiffEnd(tr.doc.content)
          if (start != null && end && (!tr.before.resolve(start).sameParent(tr.before.resolve(end.a)) ||
            !tr.doc.resolve(start).sameParent(tr.doc.resolve(end.b)))) return
          mark(true)
          if (start!=null && !view.composing) removed = removeBlankLine(tr,start)
        }
        const was = view.state.selection.$head.parent.attrs.id
        view.updateState(view.state.apply(tr))
        if (removed || (was !== view.state.selection.$head.parent.attrs.id && view.state.selection.empty && !view.composing)) void save()
      },
      handleKeyDown(_,e) {
        if (e.isComposing || view.composing) return false
        if (command(e) && !e.altKey && e.key.toLowerCase()==='a') {
          view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)))
          return true
        }
        if (command(e) && !e.altKey && e.key.toLowerCase()==='z') {
          void run({kind:e.shiftKey ? 'redo' : 'undo'})
          return true
        }
        if (e.key==='Escape') { void finish().then(ok=>{ if (ok && !disposed) props.current.leave() }); return true }
        if (e.key==='Enter') { void save(); return true }
        if (e.key==='Backspace' || e.key==='Delete') {
          syncSelection()
          if (passage(true)) return replace('')
          const {empty,$head} = view.state.selection
          if (empty && (e.key==='Backspace' ? !$head.parentOffset : $head.parentOffset===$head.parent.content.size)) return true
        }
        return false
      },
      handleTextInput:(_,from,to,text) => from!==to && passage(false) && replace(text),
      handlePaste(_,event) {
        const plain = event.clipboardData?.getData('text/plain')
        if (!plain) return true
        syncSelection()
        const text = plain.replace(/[\r\n]+/g,' ')
        if (!passage(false)) view.dispatch(view.state.tr.insertText(text))
        else replace(text)
        return true
      },
      handleDOMEvents:{
        beforeinput:(_,event) => {
          const e = event as InputEvent
          if (e.isComposing) return false
          if (e.inputType==='historyUndo' || e.inputType==='historyRedo') {
            e.preventDefault(); void run({kind:e.inputType==='historyUndo' ? 'undo' : 'redo'}); return true
          }
          const deleting = e.inputType.startsWith('delete')
          if (!deleting && e.inputType!=='insertText') return false
          syncSelection()
          if (!passage(deleting)) return false
          e.preventDefault(); replace(e.data ?? ''); return true
        },
        cut:(_,event) => {
          syncSelection()
          if (!passage(true)) return false
          const {from,to} = view.state.selection
          event.preventDefault()
          event.clipboardData?.setData('text/plain',view.state.doc.textBetween(from,to,'\n'))
          replace(''); return true
        },
        compositionend:() => {
          requestAnimationFrame(()=>{
            if (!disposed && dirty && !view.composing && !view.state.selection.$head.parent.textContent.trim()) void save()
          })
          return false
        },
        drop:(_,e) => { e.preventDefault(); return true },
        blur:() => { if (!view.composing) void save(); return false },
      },
    })
    sync.current = refresh
    controls.current = {finish,step:kind=>run({kind}),revert:(id,removed)=>run(removed && id!==null ? {kind:'restoreLine',id} : {kind:'revert',id})}
    resolveIssue.current = async useDraft => {
      if ((problem?.kind === 'failed' || problem?.kind === 'reload') && useDraft) {
        const action = retryCommand
        retryCommand = undefined; report()
        if (action) await action()
        else await save()
        return
      }
      retryCommand=undefined
      const remote = await window.yogurt.transcript.snapshot(id).catch(()=>undefined)
      if (!remote || disposed) return
      const next = {revision:remote.revision,lines:remote.lines.filter(l=>!l.hidden)}
      const edits = documentChanges(base.lines,view.state.doc)
      if (useDraft && problem?.kind==='conflict' && edits.length===1) {
        const row=next.lines.find(l=>l.id===edits[0].id)
        if (!row || row.text !== problem.text) { report({kind:'stale'}); return }
        const desired=edits[0].text
        refresh(next,true)
        const draft=next.lines.map(l=>l.id===row.id ? {...l,text:desired ?? l.text} : l)
        view.updateState(state(transcriptDocument(draft),view.state.selection.head))
        mark(true); report(); await save()
      } else { report(); refresh(next,true) }
      view.focus()
    }
    view.focus()
    return () => {
      if (dirty && !problem) void finish()
      disposed=true; sync.current=undefined; controls.current=null; view.destroy()
    }
  },[id,controls])
  useLayoutEffect(()=>{ sync.current?.(saved) },[saved.revision,saved.lines])
  return <>
    {issue && <div ref={issueAlert} role="alert" className="transcript-edit-issue">
      <span>{issue.kind==='conflict' ? issue.text : issue.kind==='stale' ? t('The transcript changed. Select the lines again.') : issue.kind==='reload' ? t("Couldn't load this content.") : t('Couldn’t save the transcript change.')}</span>
      {(issue.kind!=='stale') && <button className="workspace-button" onClick={()=>resolveIssue.current?.(true)}>{issue.kind==='conflict' ? t('Use my wording') : t('Try again')}</button>}
      <button className="ghost-btn" onClick={()=>resolveIssue.current?.(false)}>{t('Keep saved wording')}</button>
    </div>}
    <div ref={host} hidden={reviewing} />
  </>
}
