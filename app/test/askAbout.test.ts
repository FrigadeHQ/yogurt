import { describe, expect, it } from 'vitest'
import { aboutAsk } from '../src/main/askAbout'
import { chatPrefix, chatPrompt } from '../src/main/chat'
import { libraryHead, libraryPrompt } from '../src/main/library/prompt'

describe('Ask knows what it is', () => {
  it('is short: a few tokens, not a manual', () => {
    expect(aboutAsk.length).toBeLessThanOrEqual(400)
    // about 4 characters a token
    expect(Math.ceil(aboutAsk.length / 4)).toBeLessThanOrEqual(100)
    expect(aboutAsk).toMatch(/Yogurt/)
    expect(aboutAsk).toMatch(/on this computer/)
    expect(aboutAsk).toMatch(/can't join calls, browse the web or change settings/)
  })

  it('is in the instructions every question across meetings starts with, even when no meeting matched', () => {
    expect(libraryHead).toContain(aboutAsk)
    expect(libraryPrompt({ items: [], question: 'what can you do', history: [], now: 0, spelling: '' })).toContain(aboutAsk)
  })

  it('is in a question about one meeting, after the transcript, so the start the notes share stays the same', () => {
    const p = chatPrompt({ context: '<transcript>\nYou: hi\n</transcript>', question: 'what can you do', history: [], recording: false })
    expect(p).toContain(aboutAsk)
    expect(chatPrefix('ctx')).not.toContain(aboutAsk)
    expect(p.indexOf(aboutAsk)).toBeGreaterThan(p.indexOf('</transcript>'))
  })
})
