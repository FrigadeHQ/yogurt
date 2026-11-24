/** Highlight changed words, keeping repeated words and punctuation in their original order. */
export function transcriptDiff(original:string, current:string, locale?:string) {
  const segmenter = new Intl.Segmenter(locale,{granularity:'word'})
  const split = (s:string) => Array.from(segmenter.segment(s), part=>part.segment)
  const a = split(original), b = split(current)
  let start=0, endA=a.length, endB=b.length
  while (start<endA && start<endB && a[start]===b[start]) start++
  while (endA>start && endB>start && a[endA-1]===b[endB-1]) { endA--; endB-- }
  const old = new Set<number>(), added = new Set<number>()
  const width=endB-start+1, height=endA-start+1
  // A pasted document can be a single ASR line. Bound the comparison to its changed middle.
  if (width*height <= 250_000) {
    const lengths = new Uint32Array(width*height)
    const at = (i:number,j:number) => (i-start)*width+j-start
    for (let i=endA-1;i>=start;i--) for (let j=endB-1;j>=start;j--)
      lengths[at(i,j)] = a[i]===b[j] ? 1+lengths[at(i+1,j+1)] : Math.max(lengths[at(i+1,j)],lengths[at(i,j+1)])
    let i=start, j=start
    while (i<endA || j<endB) {
      if (i<endA && j<endB && a[i]===b[j]) { i++; j++ }
      else if (j===endB || (i<endA && lengths[at(i+1,j)]>=lengths[at(i,j+1)])) old.add(i++)
      else added.add(j++)
    }
  } else {
    for (let i=start;i<endA;i++) old.add(i)
    for (let j=start;j<endB;j++) added.add(j)
  }
  const runs = (words:string[], changed:Set<number>) => {
    const out:Array<{changed:boolean;text:string}> = []
    words.forEach((text,i)=>{
      const different = changed.has(i), last=out.at(-1)
      if (last && last.changed===different) last.text+=text
      else out.push({changed:different,text})
    })
    return out
  }
  return {before:runs(a,old),after:runs(b,added)}
}
