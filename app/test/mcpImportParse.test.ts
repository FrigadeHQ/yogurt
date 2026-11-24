import { describe, expect, it } from 'vitest'
import { parseTranscript, timedLines, toSegments } from '../src/main/mcp/transcriptImport'

describe('reading a transcript pasted from another notes app', () => {
  it('reads "[mm:ss] Name: text" lines, hours too', () => {
    expect(parseTranscript('[00:05] Ann Lee: Can we keep travel flat?\n[01:02:03] Bo Park: Sure.')).toEqual([
      { startMs: 5_000, endMs: null, speaker: 'Ann Lee', text: 'Can we keep travel flat?' },
      { startMs: 3_723_000, endMs: null, speaker: 'Bo Park', text: 'Sure.' },
    ])
  })
  it('reads "Name (00:12:34): text" lines', () => {
    expect(parseTranscript('Ann Lee (00:12:34): Budget is flat.\nBo Park (12:40): Agreed')).toEqual([
      { startMs: 754_000, endMs: null, speaker: 'Ann Lee', text: 'Budget is flat.' },
      { startMs: 760_000, endMs: null, speaker: 'Bo Park', text: 'Agreed' },
    ])
  })
  it('reads "Name: text" lines without times', () => {
    expect(parseTranscript('Ann Lee: Hello there.\nMe: Hi Ann, see https://example.com at 10:30.')).toEqual([
      { startMs: null, endMs: null, speaker: 'Ann Lee', text: 'Hello there.' },
      { startMs: null, endMs: null, speaker: 'Me', text: 'Hi Ann, see https://example.com at 10:30.' },
    ])
  })
  it('reads a name and time on their own line with the words under it (Otter, Fireflies)', () => {
    expect(parseTranscript('Ann Lee  0:05\nCan we keep travel flat?\nI think so.\n\nBo Park  0:20\nSure.')).toEqual([
      { startMs: 5_000, endMs: null, speaker: 'Ann Lee', text: 'Can we keep travel flat? I think so.' },
      { startMs: 20_000, endMs: null, speaker: 'Bo Park', text: 'Sure.' },
    ])
  })
  it('gives no name to words nobody is named for, or an unknown speaker', () => {
    expect(parseTranscript('[00:01] Welcome, everyone.\nUnknown speaker: Hi.\nJust a sentence on its own.')).toEqual([
      { startMs: 1_000, endMs: null, speaker: null, text: 'Welcome, everyone.' },
      { startMs: null, endMs: null, speaker: null, text: 'Hi. Just a sentence on its own.' },
    ])
  })
  it('a paragraph after a blank line is a new line by the same speaker', () => {
    expect(parseTranscript('Ann Lee: First.\n\nSecond.')).toEqual([
      { startMs: null, endMs: null, speaker: 'Ann Lee', text: 'First.' },
      { startMs: null, endMs: null, speaker: 'Ann Lee', text: 'Second.' },
    ])
  })
})

describe('timing imported lines', () => {
  it('ends each line where the next starts, and estimates the last from its words', () => {
    const lines = timedLines([{ startMs: 5_000, endMs: null, speaker: 'A', text: 'one two' }, { startMs: 9_000, endMs: null, speaker: 'B', text: 'three four five' }])
    expect(lines.map((l) => [l.startMs, l.endMs])).toEqual([[5_000, 9_000], [9_000, 10_200]])
  })
  it('lines without times follow each other in order', () => {
    const lines = timedLines([{ startMs: null, endMs: null, speaker: 'A', text: 'one' }, { startMs: null, endMs: null, speaker: 'B', text: 'two' }])
    expect(lines.map((l) => [l.startMs, l.endMs])).toEqual([[0, 1_000], [1_000, 2_000]])
  })
  it('keeps given end times', () => {
    expect(timedLines([{ startMs: 1_000, endMs: 3_500, speaker: null, text: 'hi' }])[0]).toMatchObject({ startMs: 1_000, endMs: 3_500 })
  })
})

describe('imported lines as transcript lines', () => {
  it("puts the person's own lines on their side, the rest on the other side with their names", () => {
    const segs = toSegments('m1', [
      { startMs: 0, endMs: 1_000, speaker: 'Sam Rivera', text: 'Mine.' },
      { startMs: 1_000, endMs: 2_000, speaker: 'me', text: 'Also mine.' },
      { startMs: 2_000, endMs: 3_000, speaker: 'Ann Lee', text: 'Theirs.' },
      { startMs: 3_000, endMs: 4_000, speaker: null, text: 'Nobody named.' },
    ], 'Sam Rivera')
    expect(segs).toEqual([
      { meetingId: 'm1', track: 'me', startMs: 0, endMs: 1_000, speaker: 'me', text: 'Mine.' },
      { meetingId: 'm1', track: 'me', startMs: 1_000, endMs: 2_000, speaker: 'me', text: 'Also mine.' },
      { meetingId: 'm1', track: 'them', startMs: 2_000, endMs: 3_000, speaker: 'Ann Lee', text: 'Theirs.' },
      { meetingId: 'm1', track: 'them', startMs: 3_000, endMs: 4_000, speaker: null, text: 'Nobody named.' },
    ])
  })
})
