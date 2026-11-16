// Transcript lab, combining several models' readings.
import { describe, expect, it } from 'vitest'
import { align, combine, distance, keyOf, withPicks, words } from '../src/shared/labCombine'

describe('lab combine', () => {
  it('compares words without case or punctuation around them', () => {
    expect(keyOf('"Qu’est-ce,')).toBe("qu'est-ce")
    expect(words('so — we go')).toEqual(['so —', 'we', 'go'])
    expect(distance(words('Hello, world.'), words('hello world'))).toBe(0)
  })

  it('aligns insertions and deletions', () => {
    expect(align(['a', 'b', 'c'], ['a', 'c'])).toEqual([[0, 0], [1, null], [2, 1]])
    expect(align(['a', 'c'], ['a', 'b', 'c'])).toEqual([[0, 0], [null, 1], [1, 2]])
  })

  it('takes the majority word where one model misheard', () => {
    const c = combine([
      { model: 'a', text: 'we ship the remote control on Monday' },
      { model: 'b', text: 'we ship the remote patrol on Monday' },
      { model: 'c', text: 'we ship the remote control on Sunday' },
    ])
    expect(c.text).toBe('we ship the remote control on Monday')
    expect(c.choices).toHaveLength(2)
    expect(c.choices[0].options.map((o) => o.text)).toEqual(['control', 'patrol'])
  })

  it('drops a word only some models made up, keeps one most heard', () => {
    expect(combine([
      { model: 'a', text: 'thank you very much' },
      { model: 'b', text: 'thank you so very much' },
      { model: 'c', text: 'thank you very much' },
    ]).text).toBe('thank you very much')
    expect(combine([
      { model: 'a', text: 'it is ready' },
      { model: 'b', text: 'it is not ready' },
      { model: 'c', text: 'it is not ready' },
    ]).text).toBe('it is not ready')
  })

  it('lets the more trusted model win a split vote, written its way', () => {
    const c = combine([
      { model: 'weak', text: 'call Zoe tomorrow', weight: 0.6 },
      { model: 'strong', text: 'call Zoé tomorrow.', weight: 0.9 },
    ])
    expect(c.text).toBe('call Zoé tomorrow.')
  })

  it('agrees fully when every model heard the same, and handles nothing heard', () => {
    expect(combine([{ model: 'a', text: 'yes' }, { model: 'b', text: 'Yes.' }]).agreement).toBe(1)
    expect(combine([]).text).toBe('')
    expect(combine([{ model: 'a', text: '' }, { model: 'b', text: '' }]).text).toBe('')
  })

  it('applies picks made later', () => {
    const c = combine([
      { model: 'a', text: 'meet at Shape today' },
      { model: 'b', text: 'meet at shape today' },
      { model: 'c', text: 'meet at Chape today' },
    ])
    // Shape and shape are one word: two votes for it against one for Chape
    expect(c.text).toBe('meet at Shape today')
    expect(c.choices[0].options.map((o) => [o.text, o.models.length])).toEqual([['Shape', 2], ['Chape', 1]])
    const d = combine([{ model: 'a', text: 'meet at Shape' }, { model: 'b', text: 'meet at Chape' }])
    expect(withPicks(d, new Map([[0, 1]]))).toBe('meet at Chape')
  })
})

describe('lab combine with the meeting names', () => {
  it("lets the models that heard a meeting's name outvote everyday words", () => {
    const rs = [
      { model: 'a', text: 'ask Siobhan about it' },
      { model: 'b', text: 'ask Shivon about it' },
      { model: 'c', text: 'ask Chevonne about it' },
    ]
    expect(combine(rs).text).toBe('ask Siobhan about it') // no majority: the pivot's word
    expect(combine([rs[1], rs[2], rs[0]], { terms: ['Siobhan'] }).text).toBe('ask Siobhan about it')
    expect(combine([{ model: 'a', text: 'the shape of it' }, { model: 'b', text: 'the shape of it' }, { model: 'c', text: 'the Shape of it' }], { terms: ['Shape'] }).agreement).toBe(1)
  })
})

describe('lab readings that count', () => {
  it('leaves out a reading in another alphabet than the language', async () => {
    const { inScript, readingsFor } = await import('../src/main/lab/index')
    expect(inScript('ला ला', 'fr')).toBe(false)
    expect(inScript("C'est l'IA, ok.", 'fr')).toBe(true)
    expect(inScript('...', 'en')).toBe(true)
    const got = new Map([['q', new Map([['k', { text: 'ला ला' }]])], ['c', new Map([['k', { text: 'La la la.' }]])]])
    const models = [{ id: 'q', label: 'q', engine: 'transcribe' as const, path: '', takes: [] }, { id: 'c', label: 'c', engine: 'transcribe' as const, path: '', takes: [] }]
    expect(readingsFor(models, 'k', 'fr', got).map((r) => r.model)).toEqual(['c'])
  })
})
