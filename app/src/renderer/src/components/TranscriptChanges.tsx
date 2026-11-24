import { t } from '../../../shared/i18n'
import { clock } from '../../../shared/transcript'
import { transcriptDiff } from '../../../shared/transcriptDiff'
import type { TranscriptDifference } from '../../../shared/transcriptEdit'

export function TranscriptChanges({changes,restore,revertAll}:{revertAll:()=>void;changes:TranscriptDifference[];restore:(id:number,removed:boolean)=>void}) {
  return <section className="transcript-changes" aria-label={t('Changes')}>
    <header><button className="ghost-btn transcript-tool" onClick={revertAll}>{t('Revert all')}</button></header>
    {changes.map(change=>{
      const {before,after}=transcriptDiff(change.original,change.current ?? '')
      return <article key={change.id}>
        <header><time dir="ltr">{clock(change.startMs)}</time>
          <button className="ghost-btn transcript-tool" onClick={()=>restore(change.id,change.current===null)}>{change.current===null ? t('Restore line') : t('Restore original wording')}</button>
        </header>
        <p className="transcript-diff-before"><span aria-hidden="true">−</span><del dir="auto">{before.map((p,i)=>p.changed ? <mark key={i}>{p.text}</mark> : p.text)}</del></p>
        {change.current!==null && <p className="transcript-diff-after"><span aria-hidden="true">+</span><ins dir="auto">{after.map((p,i)=>p.changed ? <mark key={i}>{p.text}</mark> : p.text)}</ins></p>}
      </article>
    })}
  </section>
}
