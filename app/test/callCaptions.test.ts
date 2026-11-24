import { describe, expect, it } from 'vitest'
import { finishCaptions, foldCaptions, type CaptionLine } from '../src/main/callNames/captions'

const fold = (readings: Array<Array<[string, string]>>) => {
  const lines: CaptionLine[] = []
  readings.forEach((rows, i) => foldCaptions(lines, rows.map(([who, text]) => ({ who, text })), 1000 + i * 400))
  return lines
}
const said = (lines: CaptionLine[]) => lines.map((l) => [l.who, l.text])

describe('a transcript from the live captions', () => {
  it('a row that grows is one line, with its latest words and when it last changed', () => {
    const lines = fold([[['Dana', 'so the']], [['Dana', 'so the next step']], [['Dana', 'so the next step']], [['Dana', 'so the next step is the move']]])
    expect(said(lines)).toEqual([['Dana', 'so the next step is the move']])
    expect(lines[0].firstAt).toBe(1000)
    expect(lines[0].lastAt).toBe(2200)
  })

  it('a new row is a new line, also from the same person mid-sentence', () => {
    const lines = fold([
      [['Dana', 'first part of it']],
      [['Dana', 'first part of it, and more'], ['Dana', 'then a new row']],
      [['Dana', 'first part of it, and more'], ['Dana', 'then a new row opens'], ['Ann', 'hm']],
    ])
    expect(said(lines)).toEqual([['Dana', 'first part of it, and more'], ['Dana', 'then a new row opens'], ['Ann', 'hm']])
  })

  it('rows scrolling away lose nothing, and a row like an earlier one is not merged into it', () => {
    const lines = fold([
      [['Dana', 'Yes.'], ['Ann', 'okay then']],
      [['Dana', 'Yes.'], ['Ann', 'okay then'], ['Dana', 'Yes, and the rest']],
      // the first two scroll out
      [['Dana', 'Yes, and the rest of it']],
    ])
    expect(said(lines)).toEqual([['Dana', 'Yes.'], ['Ann', 'okay then'], ['Dana', 'Yes, and the rest of it']])
  })

  it('a table read again whole adds nothing', () => {
    const rows: Array<[string, string]> = [['Dana', 'one thing'], ['Ann', 'another thing']]
    expect(said(fold([rows, rows, rows]))).toEqual(rows)
  })

  it('a row seen before it lined up is dropped once a later line carries it whole', () => {
    const lines: CaptionLine[] = [
      { who: 'Dana', text: 'so the next', firstAt: 1000, lastAt: 1400 },
      { who: 'Dana', text: 'so the next step is the move', firstAt: 1800, lastAt: 4000 },
      { who: 'Dana', text: 'so', firstAt: 60_000, lastAt: 60_000 },
    ]
    expect(finishCaptions(lines).map((l) => l.text)).toEqual(['so the next step is the move', 'so'])
  })

  it('blank rows are nothing', () => {
    expect(fold([[['Dana', '   ']]])).toEqual([])
  })
})
