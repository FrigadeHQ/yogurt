import { describe, expect, it } from 'vitest'
import { MIN_TURN_MS, MERGE_GAP_MS, cleanTurns, parseRttm } from '../src/main/diarize/rttm'

const rttm = (speaker: string, start: number, dur: number, file = 'them') => `SPEAKER ${file} 1 ${start.toFixed(3)} ${dur.toFixed(3)} <NA> <NA> ${speaker} <NA> <NA>`

describe('parseRttm', () => {
  it('reads SPEAKER lines into ms turns', () => {
    expect(parseRttm(`${rttm('0', 1.5, 2.25)}\n${rttm('1', 4, 0.5)}`)).toEqual([
      { key: '0', startMs: 1500, endMs: 3750 },
      { key: '1', startMs: 4000, endMs: 4500 },
    ])
  })
  it('skips malformed lines and keeps the rest', () => {
    expect(parseRttm(['not rttm', rttm('0', 0, 1), 'SPEAKER x', `${rttm('1', 2, 1)} extra tail`].join('\n')).map(t => t.key)).toEqual(['0', '1'])
  })
  it('drops zero and negative durations', () => {
    expect(parseRttm(`${rttm('0', 0, 0)}\n${rttm('0', 0, -1)}\n${rttm('0', 0, 0.5)}`)).toEqual([{ key: '0', startMs: 0, endMs: 500 }])
  })
})

describe('cleanTurns', () => {
  it(`drops turns under ${MIN_TURN_MS} ms`, () => {
    expect(cleanTurns([{ key: 'a', startMs: 0, endMs: 199 }, { key: 'a', startMs: 1000, endMs: 1500 }])).toEqual([{ key: 'a', startMs: 1000, endMs: 1500 }])
  })
  it(`merges same-speaker turns under ${MERGE_GAP_MS} ms apart, and keeps other speakers apart`, () => {
    expect(cleanTurns([{ key: 'a', startMs: 0, endMs: 1000 }, { key: 'a', startMs: 1200, endMs: 2000 }, { key: 'b', startMs: 2100, endMs: 3000 }])).toEqual([
      { key: 'a', startMs: 0, endMs: 2000 },
      { key: 'b', startMs: 2100, endMs: 3000 },
    ])
  })
  it('keeps overlaps as they are (the dominant turn wins per word later)', () => {
    expect(cleanTurns([{ key: 'a', startMs: 0, endMs: 2000 }, { key: 'b', startMs: 1000, endMs: 3000 }])).toHaveLength(2)
  })
  it('sorts by start', () => {
    expect(cleanTurns([{ key: 'b', startMs: 5000, endMs: 6000 }, { key: 'a', startMs: 0, endMs: 1000 }])[0].key).toBe('a')
  })
})
