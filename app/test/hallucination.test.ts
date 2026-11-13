import { describe, expect, it } from 'vitest'
import { isPromptEcho, isSilenceGuess, withoutPromptLabel } from '../src/main/asr/hallucination'

describe('prompt echo', () => {
  const prompt = 'Northwind sync. With Sam Lee of Northwind and Joe Park of Acme.'
  it('is a line that only repeats the prompt, or a run of two or more of its words', () => {
    expect(isPromptEcho('Sam Lee of Northwind.', 'With Sam Lee of Northwind.')).toBe(true)
    expect(isPromptEcho('With Sam Lee of Northwind.', 'With Sam Lee of Northwind.')).toBe(true)
    expect(isPromptEcho('Northwind sync.', prompt)).toBe(true)
    expect(isPromptEcho('joe park of acme', prompt)).toBe(true)
  })
  it('is not a line with words of its own, a single word, or anything when there is no prompt', () => {
    expect(isPromptEcho('I work at Acme with Sam.', prompt)).toBe(false)
    expect(isPromptEcho('Sam Lee of Northwind, nice to meet you.', prompt)).toBe(false)
    expect(isPromptEcho('Zentrik.', prompt)).toBe(false)
    expect(isPromptEcho('Sam Lee of Northwind.', '')).toBe(false)
  })
  // seen in a real standup: whisper cut the read-back short, mid-word, or put one stray word before it
  const standup = 'Standup. With Ana, Maya Lopez, Omar and Sam Lee of Northwind.'
  it('is the prompt read back with its last word cut off', () => {
    expect(isPromptEcho('Omar and Sam Lee of Northw.', standup)).toBe(true)
    expect(isPromptEcho('Ana, Maya Lopez, Omar and Sam Lee of Northw.', standup)).toBe(true)
  })
  it('is a long read-back with one stray word', () => {
    expect(isPromptEcho('to Omar and Sam Lee of Northwind.', standup)).toBe(true)
  })
  it('keeps real lines that use a name or two', () => {
    expect(isPromptEcho('Omar Reyes for some reason.', standup)).toBe(false)
    expect(isPromptEcho('Thanks Dana.', standup)).toBe(false)
    expect(isPromptEcho('Ask Maya Lopez about it.', standup)).toBe(false)
    expect(isPromptEcho('Dana and Kai.', standup)).toBe(false)
  })
})

describe('silence guesses', () => {
  it("are the stock lines whisper writes on quiet audio", () => {
    for (const t of ['Thank you.', 'Thanks for watching!', 'you', 'Bye.', 'Thank you for watching.', 'Thank you very much.', 'Bye!']) expect(isSilenceGuess(t)).toBe(true)
  })
  it('are not real sentences that start the same way', () => {
    for (const t of ['Thank you for the update on the budget.', 'You said Tuesday.', 'Bye for now, see you Monday.']) expect(isSilenceGuess(t)).toBe(false)
  })
})

describe('the prompt read back as a speaker label', () => {
  const prompt = 'Product board. With Eric and Christian Mathiesen.'
  it('takes off names from the prompt that whisper put before real speech as a label', () => {
    expect(withoutPromptLabel('Eric and Christian Mathiesen: So let me just get', prompt)).toBe('So let me just get')
    expect(withoutPromptLabel('With Eric and Christian Mathiesen: Hurt to summarize the product board.', prompt)).toBe('Hurt to summarize the product board.')
    expect(withoutPromptLabel('Christian Mathiesen: okay', prompt)).toBe('okay')
    expect(withoutPromptLabel('Eric: yeah, let me check', prompt)).toBe('yeah, let me check')
  })
  it('leaves speech alone: a colon that follows words of its own, or names nobody gave it', () => {
    expect(withoutPromptLabel('Here is the plan: ship Friday', prompt)).toBe('Here is the plan: ship Friday')
    expect(withoutPromptLabel('Note: the product board is late', prompt)).toBe('Note: the product board is late')
    expect(withoutPromptLabel('Eric and Christian Mathiesen joined late', prompt)).toBe('Eric and Christian Mathiesen joined late')
    expect(withoutPromptLabel('Eric and Christian Mathiesen:', prompt)).toBe('Eric and Christian Mathiesen:')
    expect(withoutPromptLabel('Eric: hi', '')).toBe('Eric: hi')
  })
})
