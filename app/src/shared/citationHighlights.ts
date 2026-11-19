import type { PMNode } from './markdown'

/** Wrap only the exact sentence attached to a citation, preserving inline formatting. */
export function citationHighlights(node: PMNode): PMNode {
  if (!node.content) return node
  const children = node.content.map(citationHighlights)
  if (node.type !== 'paragraph' && node.type !== 'heading') return { ...node, content: children }
  const flat = children.flatMap(n => n.type === 'citationAnchor' ? n.content ?? [] : [n])
  const out: PMNode[] = []
  for (const n of flat) {
    if (n.type !== 'citation') { out.push(n); continue }
    const sentence = String(n.attrs?.sentence ?? '')
    if (!sentence || !(n.attrs?.marks as unknown[])?.length) continue
    const tail: PMNode[] = []
    for (let i = out.length - 1; i >= 0 && out[i].type === 'text'; i--) tail.unshift(out[i])
    // Never attach a source to a guessed or partial text range.
    if (!tail.map(t => t.text ?? '').join('').endsWith(sentence)) continue
    let remaining = sentence.length
    const content: PMNode[] = []
    while (remaining) {
      const text = out.pop()!, value = text.text ?? '', take = Math.min(remaining, value.length)
      content.unshift({ ...text, text: value.slice(value.length - take) })
      if (take < value.length) out.push({ ...text, text: value.slice(0, -take) })
      remaining -= take
    }
    out.push({ type: 'citationPassageTrigger', attrs: { ...n.attrs }, content })
  }
  return { ...node, content: out }
}
