import { afterEach, describe, expect, it } from 'vitest'
import { addNickname, cleanNicknames, contextBody, CONTEXT_CHARS, MAX_NICKNAMES, mentionIn, mentionNames } from '../src/shared/mentions'
import { createMentionAlerts, MENTION_QUIET_MS, type MentionNotice } from '../src/main/mentions'
import { meetingWords, setOwnerName, setOwnerNicknames, whisperPrompt } from '../src/main/vocab'

describe('mentionNames', () => {
  it('listens for the full name, the first name and each nickname, once each', () => {
    expect(mentionNames('Vincent  Moreau', ['Vince', 'vincent', ' Vinny '])).toEqual(['Vincent Moreau', 'Vincent', 'Vince', 'Vinny'])
  })
  it('leaves out an initial and blanks', () => {
    expect(mentionNames('J. Smith', ['', 'A'])).toEqual(['J. Smith'])
    expect(mentionNames('', [])).toEqual([])
  })
})

describe('mentionIn', () => {
  const names = mentionNames('Vincent Moreau', ['Vince'])
  it('hears a name as a whole word, whatever its case, with what follows it', () => {
    expect(mentionIn("Vince, what do you think?", names)).toBe('Vince')
    expect(mentionIn("that's vince's call", names)).toBe('Vince')
    expect(mentionIn('Over to you, Vincent.', names)).toBe('Vincent')
  })
  it('never hears a name inside another word', () => {
    expect(mentionIn("I'm not convinced", names)).toBeNull()
    expect(mentionIn('Vincenzo will join later', names)).toBeNull()
  })
  it('prefers the full name, and lets any spaces stand between its words', () => {
    expect(mentionIn('ask Vincent   Moreau about it', names)).toBe('Vincent Moreau')
  })
  it('hears a name with or without its accents', () => {
    expect(mentionIn('jose, can you share?', ['José'])).toBe('José')
    expect(mentionIn('Zoë said José would know', ['Jose'])).toBe('Jose')
  })
  it('hears nothing with no names', () => expect(mentionIn('Vince?', [])).toBeNull())
})

describe('nicknames', () => {
  it('adds a name once, tidied, up to the limit', () => {
    expect(addNickname([], '  Vin  ny ')).toEqual(['Vin ny'])
    const list = ['Vince']
    expect(addNickname(list, 'VINCE')).toBe(list)
    expect(addNickname(list, '   ')).toBe(list)
    const full = Array.from({ length: MAX_NICKNAMES }, (_, i) => `N${i}`)
    expect(addNickname(full, 'More')).toBe(full)
  })
  it('makes what was saved safe', () => {
    expect(cleanNicknames(['Vince', 3, 'vince', null, 'Vinny'])).toEqual(['Vince', 'Vinny'])
    expect(cleanNicknames('Vince')).toEqual([])
  })
})

describe('contextBody', () => {
  it('puts the mention first (a banner shows only its start), then who said what before it, in order', () => {
    expect(contextBody([{ who: 'Sarah', text: 'Where are we?' }, { who: 'You', text: 'I can look at it.' }, { who: 'Sarah', text: '  Great,  thanks Vince. ' }], 'Vince'))
      .toBe('Great, thanks Vince.\nSarah: Where are we?\nYou: I can look at it.')
  })
  it('drops the oldest lines first when there is too much', () => {
    const lines = [{ who: 'Them', text: 'a'.repeat(200) }, { who: 'Them', text: 'b'.repeat(100) }, { who: 'Sarah', text: 'Vince?' }]
    const body = contextBody(lines, 'Vince')
    expect(body).toBe(`Vince?\nThem: ${'b'.repeat(100)}`)
    expect(body.length).toBeLessThanOrEqual(CONTEXT_CHARS)
  })
  it('cuts a long mention line down around the name, never losing it', () => {
    const text = `${'blah '.repeat(80)}so Vince, can you own the launch date? ${'and more '.repeat(40)}`
    const body = contextBody([{ who: 'Them', text: 'earlier' }, { who: 'Sarah', text }], 'Vince')
    expect(body.startsWith('…')).toBe(true)
    expect(body).not.toContain('earlier')
    expect(body).toContain('Vince, can you own the launch date?')
    expect(body.split('\n')[0].endsWith('…')).toBe(true)
    expect(body.length).toBeLessThanOrEqual(CONTEXT_CHARS)
  })
  it('is empty with nothing said', () => expect(contextBody([])).toBe(''))
})

describe('createMentionAlerts', () => {
  type Line = { meetingId: string; track: 'me' | 'them'; startMs: number; text: string; speaker: string | null; hidden?: boolean }
  const setup = (o: { on?: boolean; lines?: Line[] } = {}) => {
    let t = 1_000_000
    const saved: Line[] = [...(o.lines ?? [])]
    const sent: MentionNotice[] = []
    const alerts = createMentionAlerts({
      on: () => o.on ?? true,
      names: () => mentionNames('Vincent Moreau', ['Vince']),
      recent: (id, n) => saved.filter((l) => l.meetingId === id).slice(-n),
      who: (l) => (l.track === 'me' ? 'You' : l.speaker || 'Them'),
      title: (s) => (s ? `${s} mentioned you` : 'Someone mentioned you'),
      notify: (n) => sent.push(n),
      now: () => t,
    })
    const say = (l: Omit<Line, 'meetingId'> & { meetingId?: string }) => { const line = { meetingId: 'm1', ...l }; saved.push(line); alerts.line(line) }
    return { say, sent, later: (ms: number) => { t += ms } }
  }

  it('tells the person who said their name, with the lines before it', () => {
    const { say, sent } = setup()
    say({ track: 'them', startMs: 0, text: 'So the launch moves to May.', speaker: 'Sarah' })
    say({ track: 'me', startMs: 3000, text: 'Makes sense.', speaker: 'me' })
    say({ track: 'them', startMs: 5000, text: 'Vince, can you update the plan?', speaker: 'Sarah' })
    expect(sent).toEqual([{ meetingId: 'm1', title: 'Sarah mentioned you', body: 'Vince, can you update the plan?\nSarah: So the launch moves to May.\nYou: Makes sense.' }])
  })
  it('says Someone when the call app did not show who it was', () => {
    const { say, sent } = setup()
    say({ track: 'them', startMs: 0, text: 'what does Vincent think', speaker: null })
    expect(sent[0]).toMatchObject({ title: 'Someone mentioned you', body: 'what does Vincent think' })
  })
  it('ignores the mic, hidden echo lines, lines without the name, and everything when turned off', () => {
    const { say, sent } = setup()
    say({ track: 'me', startMs: 0, text: "Hi, I'm Vince.", speaker: 'me' })
    say({ track: 'them', startMs: 1000, text: 'Vince here too', speaker: null, hidden: true })
    say({ track: 'them', startMs: 2000, text: "I'm convinced.", speaker: 'Sarah' })
    expect(sent).toEqual([])
    const off = setup({ on: false })
    off.say({ track: 'them', startMs: 0, text: 'Vince?', speaker: 'Sarah' })
    expect(off.sent).toEqual([])
  })
  it('keeps quiet for a while after a mention in the same meeting, not in another', () => {
    const { say, sent, later } = setup()
    say({ track: 'them', startMs: 0, text: 'Vince?', speaker: 'Sarah' })
    later(10_000)
    say({ track: 'them', startMs: 10_000, text: 'Vince, you there?', speaker: 'Sarah' })
    say({ meetingId: 'm2', track: 'them', startMs: 0, text: 'Hey Vince', speaker: 'Lee' })
    expect(sent.map((n) => n.meetingId)).toEqual(['m1', 'm2'])
    later(MENTION_QUIET_MS)
    say({ track: 'them', startMs: 70_000, text: 'Back to Vince.', speaker: 'Sarah' })
    expect(sent).toHaveLength(3)
  })
  it('shows at most four lines, and none said after the mention', () => {
    const { say, sent } = setup({ lines: [
      ...[1, 2, 3, 4, 5].map((i) => ({ meetingId: 'm1', track: 'them' as const, startMs: i * 1000, text: `line ${i}`, speaker: 'Sarah' })),
      { meetingId: 'm1', track: 'me', startMs: 9000, text: 'said later, saved first', speaker: 'me' },
    ] })
    say({ track: 'them', startMs: 6000, text: 'Vince?', speaker: 'Sarah' })
    expect(sent[0].body).toBe('Vince?\nSarah: line 3\nSarah: line 4\nSarah: line 5')
  })
})

describe('nicknames in the whisper prompt', () => {
  afterEach(() => { setOwnerName(() => ''); setOwnerNicknames(() => []) })
  it('tells whisper the other names the person goes by', () => {
    setOwnerName(() => 'Vincent Moreau')
    setOwnerNicknames(() => ['Vinny'])
    expect(whisperPrompt(meetingWords({ title: '', titleSource: 'auto', attendees: [{ name: 'Sarah Lee', email: null }] }))).toBe('With Sarah Lee, Vincent Moreau and Vinny.')
  })
})
