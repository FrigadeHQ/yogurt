import { describe, expect, it } from 'vitest'
import { AllSelection, TextSelection } from '@tiptap/pm/state'
import { documentChanges, documentLines, replacePassage, transcriptDocument } from '../src/renderer/src/transcriptDocument'
import { transcriptDiff } from '../src/shared/transcriptDiff'

const rows = ['Keep this', 'Middle', 'That stays'].map((text,i)=>({
  id:i+1,meetingId:'test',track:i===1 ? 'them' as const : 'me' as const,startMs:i*1000,endMs:i*1000+900,speaker:null,text,
}))
const doc = transcriptDocument(rows), [a,,b]=documentLines(doc)
describe('editing across audio timestamps', () => {
  it.each([false,true])('preserves both unselected ends and removes only whole lines (backward=%s)',backwards=>{
    const start=a.start+4,end=b.start+5
    const sel=TextSelection.create(doc,backwards ? end : start,backwards ? start : end)
    const next=replacePassage(doc,sel,' this part',rows)!
    expect(documentChanges(rows,next.doc)).toEqual([
      {id:1,expected:'Keep this',text:'Keep this part'},{id:2,expected:'Middle',text:null},{id:3,expected:'That stays',text:'stays'},
    ])
    expect(next.selection.$head.parent.attrs.id).toBe(1)
  })
  it('removes a full-document selection and keeps a valid empty document',()=>{
    const next=replacePassage(doc,new AllSelection(doc),'',rows)!
    expect(documentLines(next.doc)).toEqual([])
    expect(documentChanges(rows,next.doc).map(r=>r.text)).toEqual([null,null,null])
  })
  it('leaves a touched but unselected endpoint alone',()=>{
    const next=replacePassage(doc,TextSelection.create(doc,a.start,b.start),'',rows)!
    expect(documentLines(next.doc).map(r=>r.text)).toEqual(['That stays'])
  })
})
describe('Changes',()=>{
  it('highlights separate corrected words and retains the unchanged words between them',()=>{
    const diff=transcriptDiff('Green pears and ripe apples','Red pears and ripe plums')
    expect(diff.before.filter(r=>r.changed).map(r=>r.text)).toEqual(['Green','apples'])
    expect(diff.after.filter(r=>r.changed).map(r=>r.text)).toEqual(['Red','plums'])
  })
  it.each(['東京駅に行きます','مرحبا بالعالم','One, two!'])('preserves removed text exactly: %s',original=>{
    expect(transcriptDiff(original,'')).toEqual({before:[{text:original,changed:true}],after:[]})
  })
})
