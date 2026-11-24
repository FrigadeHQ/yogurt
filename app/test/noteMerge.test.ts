import { describe, expect, it } from 'vitest'
import { mergeNoteView } from '../src/renderer/src/noteMerge'
import type { NoteView } from '../src/shared/types'
import { FROM_IPHONE } from '../src/shared/companion'

const view = (o: Partial<NoteView>): NoteView => ({ meetingId: 'm', mine: '', enhanced: '## A\n- Someone ships', edited: false, status: 'done', draft: '', peopleChanged: false, ...o })

describe('mergeNoteView: a note open on screen when it is written again for new people', () => {
  it('nothing typed since: the new notes show, all at once', () => {
    const next = view({ enhanced: '## A\n- Bo Park ships', rewrittenFrom: '## A\n- Someone ships' })
    expect(mergeNoteView(view({}), next).view.enhanced).toBe('## A\n- Bo Park ships')
  })
  it('edits not saved yet: theirs stay on screen (saving them marks the notes as edited)', () => {
    const cur = view({ enhanced: '## A\n- Someone ships Friday' })
    const next = view({ enhanced: '## A\n- Bo Park ships', rewrittenFrom: '## A\n- Someone ships' })
    const merged = mergeNoteView(cur, next)
    expect(merged.view.enhanced).toBe('## A\n- Someone ships Friday')
    // the app is told, so the notes still say the people changed
    expect(merged.keptEdits).toBe(true)
    expect(mergeNoteView(view({}), next).keptEdits).toBeUndefined()
  })
  it('an ordinary update keeps what they typed in finished notes, as before', () => {
    const cur = view({ enhanced: 'mine now' })
    expect(mergeNoteView(cur, view({ peopleChanged: true })).view).toMatchObject({ enhanced: 'mine now', peopleChanged: true })
  })
  it('the first view is taken as it is', () => {
    expect(mergeNoteView(undefined, view({})).view.enhanced).toBe('## A\n- Someone ships')
  })
  it.each(['failed', 'stopped'] as const)('an older %s rewrite view cannot replace newer edits, including an emptied result', status => {
    for (const enhanced of ['new text typed after a rewrite', '']) {
      const cur = view({ status, enhanced, edited: true })
      expect(mergeNoteView(cur, view({ status, enhanced: 'older saved text' })).view.enhanced).toBe(enhanced)
    }
    expect(mergeNoteView(view({ status: 'writing', enhanced: 'old text' }), view({ enhanced: 'successful replacement' })).view.enhanced).toBe('successful replacement')
  })

  describe('My notes changed on the iPhone while the note is open', () => {
    it('nothing typed here since: the phone text shows', () => {
      const merged = mergeNoteView(view({ mine: 'desk' }), view({ mine: 'from the phone', mineFrom: 'desk' }))
      expect(merged.view.mine).toBe('from the phone')
      expect(merged.resaveMine).toBeUndefined()
    })
    it('typed here and not saved yet: theirs stay, the phone text goes under a heading and is saved again', () => {
      const merged = mergeNoteView(view({ mine: 'desk, typed more' }), view({ mine: 'from the phone', mineFrom: 'desk' }))
      expect(merged.view.mine).toBe('desk, typed more' + FROM_IPHONE + 'from the phone')
      expect(merged.resaveMine).toBe(true)
    })
    it('an ordinary update still keeps what they typed', () => {
      expect(mergeNoteView(view({ mine: 'typing' }), view({ mine: 'older' })).view.mine).toBe('typing')
    })
  })
})
