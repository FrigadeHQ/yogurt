import type { Segment } from './types'

type Line = Omit<Segment,'id'> & {id?:number;previous?:boolean}
/** New words replace the old reading surface from the top; storage still owns the original. */
export function transcriptReplacement(saved:Line[],draft:Line[]):Line[] {
  const end=Math.max(0,...draft.map(line=>line.endMs))
  return [...draft,...saved.filter(line=>line.startMs>=end).map(line=>({...line,previous:true}))]
    .sort((a,b)=>a.startMs-b.startMs)
}
/** A known speaker survives a new segmentation only when every overlapping attribution agrees. */
export function previousSpeaker(lines:Line[],track:Segment['track'],startMs:number,endMs:number):string|null {
  const overlap=lines.filter(line=>line.track===track&&line.startMs<endMs&&line.endMs>startMs)
  const names=new Set(overlap.map(line=>line.speaker))
  return names.size===1 ? overlap[0]?.speaker??null : null
}
