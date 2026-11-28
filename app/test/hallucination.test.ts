import { describe, expect, it } from 'vitest'
import { isPromptEcho, isSilenceGuess, isSubtitleCredit, withoutPromptLabel } from '../src/main/asr/hallucination'

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
  it('include the Spanish ones', () => {
    for (const t of ['Gracias.', '¡Muchas gracias!', 'Gracias por ver el video.', 'Gracias por ver el vídeo.', 'Subtítulos realizados por la comunidad de Amara.org', '¡Suscríbete al canal!']) expect(isSilenceGuess(t)).toBe(true)
    for (const t of ['Gracias por la actualización del presupuesto.', 'Gracias, nos vemos el lunes.', 'Sí, gracias por ver el video que mandé.']) expect(isSilenceGuess(t)).toBe(false)
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
  it('also when whisper shuffles the prompt\'s names and drops its little words (#30)', () => {
    const p = 'Weekly sync. With Corinna Weber and Jonas Braun of Acme GmbH.'
    expect(withoutPromptLabel('GmbH, Corinna Weber Jonas Braun: Okay.', p)).toBe('Okay.')
    expect(withoutPromptLabel('Jonas Braun, Corinna Weber: sounds good', p)).toBe('sounds good')
    // one word of its own and it is speech
    expect(withoutPromptLabel('Corinna Weber said: sounds good', p)).toBe('Corinna Weber said: sounds good')
  })
  it('leaves speech alone: a colon that follows words of its own, or names nobody gave it', () => {
    expect(withoutPromptLabel('Here is the plan: ship Friday', prompt)).toBe('Here is the plan: ship Friday')
    expect(withoutPromptLabel('Note: the product board is late', prompt)).toBe('Note: the product board is late')
    expect(withoutPromptLabel('Eric and Christian Mathiesen joined late', prompt)).toBe('Eric and Christian Mathiesen joined late')
    expect(withoutPromptLabel('Eric and Christian Mathiesen:', prompt)).toBe('Eric and Christian Mathiesen:')
    expect(withoutPromptLabel('Eric: hi', '')).toBe('Eric: hi')
  })
})

describe("whisper's subtitle credits (#138: Russian ones on a quiet track)", () => {
  it('are credit lines in any of the usual languages, whoever they name', () => {
    for (const t of [
      'Редактор субтитров А.Семкин Корректор А.Егорова', 'Редактор субтитров М.Лосева Корректор А.Егорова', 'Корректор А.Кулакова',
      'Субтитры сделал DimaTorzok', 'Субтитры создавал DimaTorzok', 'Субтитры подготовил И.Петров',
      'Untertitel im Auftrag des ZDF für funk, 2017', 'Untertitelung des ZDF, 2020', 'Untertitel von Stephanie Geiges',
      "Sous-titrage ST' 501", 'Sous-titres réalisés par Jean Dupont', 'Subtitles by Jane Doe', 'Captions by Rev.com',
      'Sottotitoli creati dalla comunità Amara.org', 'Subtítulos realizados por la comunidad de Amara.org', 'Legendas pela comunidade Amara.org',
      'Napisy wykonane przez Jana Kowalskiego', 'Ondertiteling door Jan de Vries', '字幕由Amara.org社区提供',
    ]) expect(isSubtitleCredit(t), t).toBe(true)
  })
  it('are not real sentences that mention subtitles or an editor', () => {
    for (const t of [
      'Нам нужен корректор для этого текста к пятнице.', 'Редактор сказал, что всё готово.', 'Субтитры к видео будут завтра?',
      'Who made the subtitles for the launch video?', 'The subtitles by default are off, can you turn them on?',
      'Die Untertitel fehlen noch im Export.', 'Les sous-titres sont en retard, on les livre lundi.',
      'Subtitles by Jane Doe were great, but the client wants a second pass on the Spanish version before Friday please',
    ]) expect(isSubtitleCredit(t), t).toBe(false)
  })
})
