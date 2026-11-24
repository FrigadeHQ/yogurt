import { Schema, type Node as DocNode } from '@tiptap/pm/model'
import { TextSelection, type Selection, type Transaction } from '@tiptap/pm/state'
import type { Segment } from '../../shared/types'
import { bubbles, clock, transcriptSpeaker, turns } from '../../shared/transcript'
import { SPEAKER_COLORS } from '../../shared/speakerColors'
import type { TranscriptRowChange } from '../../shared/transcriptEdit'

/** Only spoken words are document text. Times, names and actions stay outside the editable content. */
const schema = new Schema({ nodes: {
  doc: { content: 'turn*' },
  turn: { content: 'bubble*', attrs: { track: {}, name: {}, color: { default: null }, time: {} }, toDOM: ({ attrs: a }) =>
    ['div', { class: 'transcript-turn flex flex-col gap-[5px] ' + (a.track === 'me' ? 'items-end' : 'items-start'), 'data-testid': 'transcript-turn', 'data-track': a.track },
      ['p', { class: a.track === 'me' ? 'sr-only' : 'turn-head flex items-baseline gap-2 px-1 text-xs', contenteditable: 'false' },
        ['span', { class: 'line-who font-medium text-muted', 'data-folder-color': a.color }, a.name], ['time', {class:'transcript-turn-time tabular-nums text-muted'}, a.time]],
      ['div', {class:'transcript-edit-bubbles'}, 0]] },
  bubble: { content: 'line*', attrs: { track: {} }, toDOM: n => ['div', { class: 'bubble bubble-' + n.attrs.track, dir:'auto', 'data-testid':'transcript-bubble', 'data-track':n.attrs.track }, 0] },
  line: { content: 'text*', marks: '', attrs: { id: {}, time: {}, corrected: {default:false} }, toDOM: ({attrs:a}) =>
    ['div', {class:'line', role:'group', 'data-key':String(a.id), 'data-testid':'transcript-line', 'data-corrected': a.corrected ? 'true' : null},
      ['time', {class:'transcript-line-time', contenteditable:'false', 'data-testid':'transcript-time'}, a.time],
      ['span', {'data-testid':'transcript-text', 'data-editable':'true'}, 0]] },
  text: {},
} })

export function transcriptDocument(lines: Segment[]) {
  return schema.node('doc', null, turns(lines).map(turn => {
    const first = turn[0]
    return schema.node('turn', {track:first.track, name:transcriptSpeaker(first), time:clock(first.startMs),
      color:first.speakerColor == null ? null : SPEAKER_COLORS[first.speakerColor]}, bubbles(turn).map(group =>
      schema.node('bubble', {track:first.track}, group.map(line =>
        schema.node('line', {id:line.id,time:clock(line.startMs),corrected:!!line.corrected}, line.text ? schema.text(line.text) : undefined)))))
  }))
}

export function documentLines(doc: DocNode) {
  const rows: Array<{id:number; text:string; start:number}> = []
  doc.descendants((n,pos) => {
    if (n.type.name !== 'line') return true
    rows.push({id:n.attrs.id, text:n.textContent, start:pos + 1})
    return false
  })
  return rows
}

/** Drop the timed row and any bubble or turn that would contain nothing else. */
export function removeBlankLine(tr:Transaction, pos:number) {
  const at = tr.doc.resolve(pos)
  if (at.parent.type !== schema.nodes.line || at.parent.textContent.trim()) return false
  let depth = at.depth
  while (depth > 1 && at.node(depth-1).childCount === 1) depth--
  tr.delete(at.before(depth),at.after(depth))
  return true
}

export function documentChanges(base: Segment[], doc: DocNode): TranscriptRowChange[] {
  const text = new Map(documentLines(doc).map(r => [r.id,r.text]))
  return base.flatMap(row => {
    const next = text.get(row.id) ?? null
    return next === row.text ? [] : [{id:row.id, expected:row.text, text:next}]
  })
}

/** Preserve the unselected ends on their own audio timestamps, even when the selection crosses speakers. */
export function replacePassage(doc: DocNode, selection: Selection, value: string, base: Segment[]) {
  const {from,to} = selection
  const rows = documentLines(doc)
  const source = new Map(base.map(l => [l.id,l]))
  let first: {id:number; offset:number} | undefined
  let removed = false
  const next = rows.flatMap(row => {
    const a = Math.max(0, from - row.start), b = Math.min(row.text.length, to - row.start)
    const line = source.get(row.id)!
    if (a >= b) {
      const result = {...line, text:row.text, breakBefore:line.breakBefore || removed}
      removed = false
      return [result]
    }
    const insert = first ? '' : value
    first ??= {id:row.id, offset:a + insert.length}
    const text = row.text.slice(0,a) + insert + row.text.slice(b)
    if (!text.trim()) { removed = true; return [] }
    const result = {...line, text, breakBefore:line.breakBefore || removed}
    removed = false
    return [result]
  })
  if (!first) return
  const nextDoc = transcriptDocument(next)
  const anchor = documentLines(nextDoc).find(r => r.id === first!.id)
  return {doc:nextDoc, selection:TextSelection.near(nextDoc.resolve(anchor ? anchor.start + first.offset : Math.min(from,nextDoc.content.size)))}
}
