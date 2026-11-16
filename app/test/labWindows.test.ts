// Transcript lab, the stretches the extra models read.
import { describe, expect, it } from 'vitest'
import type { Segment } from '../src/main/store'
import { splitBack, windowsOf } from '../src/main/lab/windows'

let n = 0
const seg = (track: 'me' | 'them', startMs: number, endMs: number, text: string, o: Partial<Segment> = {}): Segment =>
  ({ id: ++n, meetingId: 'm', track, startMs, endMs, text, speaker: track === 'me' ? 'me' : null, ...o })

describe('lab windows', () => {
  it('joins consecutive lines of one speaker, splits on pauses, speakers and length', () => {
    const ws = windowsOf([
      seg('me', 0, 4000, 'one'), seg('me', 4500, 9000, 'two'),
      seg('me', 12_000, 15_000, 'after a pause'),
      seg('them', 1000, 3000, 'Ann', { speaker: 'Ann' }), seg('them', 3500, 5000, 'Bob', { speaker: 'Bob' }),
      seg('me', 15_500, 44_000, 'too long to join'),
    ])
    expect(ws.map((w) => [w.track, w.texts.join('|')])).toEqual([
      ['me', 'one|two'], ['them', 'Ann'], ['them', 'Bob'], ['me', 'after a pause'], ['me', 'too long to join'],
    ])
    expect(ws[0].key).toBe('me:0')
  })

  it('leaves hidden echo lines out', () => {
    expect(windowsOf([seg('me', 0, 1000, 'echo', { hidden: true }), seg('me', 1200, 2000, 'mine')]).map((w) => w.texts)).toEqual([['mine']])
  })

  it('shares a new text out over the lines as the live text was', () => {
    expect(splitBack('we ship the remote control on Monday morning', ['we ship the remote', 'patrol on Monday'])).toEqual(['we ship the remote', 'control on Monday morning'])
    expect(splitBack('so first then', ['first', 'then'])).toEqual(['so first', 'then'])
    expect(splitBack('all of it', ['', ''])).toEqual(['all of it', ''])
    expect(splitBack('kept', ['dropped words here', 'kept'])).toEqual(['', 'kept'])
  })
})
