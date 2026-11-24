import { describe, expect, it } from 'vitest'
import { scoreCommand, searchPalette, searchSelectionKey } from '../src/renderer/src/searchRanking'

const commands = [
  { label: 'Settings', group: 'Go to', synonyms: ['preferences', 'prefs'] },
  { label: 'Trash', group: 'Go to' },
  { label: 'Keyboard shortcuts', group: 'Go to' },
  { label: 'Dark theme', group: 'Appearance', synonyms: ['theme', 'appearance', 'mode', 'dark'] },
  { label: 'Light theme', group: 'Appearance', synonyms: ['theme', 'appearance', 'mode', 'light'] },
  { label: 'Match my system', group: 'Appearance', synonyms: ['theme', 'appearance', 'mode', 'system'] },
  { label: 'Open at login', group: 'Settings' },
  { label: 'Dark planning', group: 'Go to', synonyms: ['Folders'] },
]
const labels = (query: string, source = commands) => searchPalette(source, [{ meetingId: 'meeting' }], query).rows
  .map(row => row.kind === 'command' ? row.command.label : row.kind === 'meeting' && row.meeting.meetingId)

describe('command scoring', () => {
  it('ranks exact labels, prefixes, word starts, aliases, then substrings', () => {
    const scores = ['dark theme', 'dark', 'theme', 'mode', 'ark'].map((q) => scoreCommand(commands[3], q))
    expect(scores).toEqual([5, 4, 3, 2, 1])
    expect(scoreCommand(commands[3], 'appearance')).toBe(2)
    expect(scoreCommand(commands[0], 'prefs')).toBe(2)
    expect(scoreCommand(commands[0], 'preferences')).toBe(2)
    expect(scoreCommand(commands[0], 'budget review')).toBe(0)
  })

  it('normalizes case and whitespace and requires every query word to match', () => {
    expect(scoreCommand(commands[3], '  DARK   THEME  ')).toBe(5)
    expect(scoreCommand(commands[3], 'theme dark')).toBe(3)
    expect(scoreCommand(commands[3], 'dark mode')).toBe(2)
    expect(scoreCommand(commands[3], 'dark budget')).toBe(0)
    expect(scoreCommand(commands[3], '(.*)')).toBe(0)
  })

  it('matches localized labels and groups, with English synonyms as a bonus', () => {
    const command = { label: 'Thème sombre', group: 'Apparence', synonyms: ['dark', 'mode'] }
    expect(scoreCommand(command, 'thème')).toBe(4)
    expect(scoreCommand(command, 'sombre')).toBe(3)
    expect(scoreCommand(command, 'apparence')).toBe(2)
    expect(scoreCommand(command, 'dark')).toBe(2)
    expect(scoreCommand({ label: '深色主题', group: '外观' }, '深色')).toBe(4)
  })
})

describe('search ordering', () => {
  it.each([
    ['dark', ['meeting', 'Dark planning', 'Dark theme']],
    ['light', ['meeting', 'Light theme']],
    ['set', ['meeting', 'Settings', 'Open at login']],
    ['trash', ['meeting', 'Trash']],
    ['short', ['meeting', 'Keyboard shortcuts']],
    ['budget review', ['meeting']],
    ['theme', ['meeting', 'Dark theme', 'Light theme', 'Match my system']],
    ['mode', ['meeting', 'Dark theme', 'Light theme', 'Match my system']],
    ['appearance', ['meeting', 'Dark theme', 'Light theme', 'Match my system']],
    ['prefs', ['meeting', 'Settings']],
    ['ark', ['meeting', 'Dark planning', 'Dark theme']],
  ])('orders commands and meetings for %s', (query, expected) => {
    expect(labels(query)).toEqual(expected)
  })

  it('keeps the empty-query order, including whitespace-only queries', () => {
    for (const query of ['', '   ']) expect(searchPalette(commands, ['1', '2', '3', '4'].map(meetingId => ({ meetingId })), query).rows.map(r => r.kind === 'meeting' && r.meeting.meetingId)).toEqual(['1', '2', '3'])
  })

  it('keeps all matching folders together in stable order', () => {
    const folders = Array.from({ length: 6 }, (_, i) => ({ label: `Plan ${i}`, group: 'Folders' }))
    expect(labels('plan', folders)).toEqual(['meeting', 'Plan 0', 'Plan 1', 'Plan 2', 'Plan 3', 'Plan 4', 'Plan 5'])
    expect(folders.map((f) => f.label)).toEqual(['Plan 0', 'Plan 1', 'Plan 2', 'Plan 3', 'Plan 4', 'Plan 5'])
  })

  it('preserves meeting order and shows commands when there are no meetings', () => {
    const meetings = [{ meetingId: 'recent' }, { meetingId: 'older' }]
    expect(searchPalette(commands, meetings, 'ark').rows.slice(0, 2)).toEqual(meetings.map(meeting => ({ kind: 'meeting', meeting })))
    expect(searchPalette(commands, [], 'prefs').rows).toEqual([{ kind: 'command', command: commands[0] }])
    expect(searchPalette(commands, [], 'unknown').rows).toEqual([])
  })
})


describe('Ask in the command palette', () => {
  const meeting = { title: 'Budget review', confident: true }
  it('groups meeting and command matches and selects the strongest intent', () => {
    const command = searchPalette(commands, [meeting], 'dark')
    expect(command.rows.map(r => r.kind)).toEqual(['meeting', 'command', 'command'])
    expect(command.rows[command.active]).toEqual({ kind: 'command', command: commands[7] })
    expect(searchPalette(commands, [meeting], 'dark', ' dark ').active).toBe(command.active)
    const found = searchPalette(commands, [meeting], 'budget')
    expect(found.rows[0].kind).toBe('meeting')
    expect(found.rows[found.active]).toEqual({ kind: 'meeting', meeting })
  })
  it.each(['Budget review?', 'who', 'what', 'when', 'where', 'why', 'how', 'did', 'does', 'is', 'are', 'can', 'should'])('selects Ask for a question starting with %s', query => {
    const palette = searchPalette(commands, [meeting], query)
    expect(palette.active).toBe(0)
    expect(palette.rows[0]).toEqual({ kind: 'ask', query })
  })
  it('uses word boundaries for question words', () => {
    const palette = searchPalette(commands, [meeting], 'island')
    expect(palette.rows[palette.active].kind).toBe('meeting')
  })
  it('leaves unmatched searches empty and keeps weak matches selectable', () => {
    expect(searchPalette(commands, [], 'unfindable')).toEqual({ rows: [], active: 0 })
    expect(searchPalette(commands, [{ confident: false }], 'budget').active).toBe(0)
    expect(searchPalette(commands, [], 'prefs').active).toBe(0)
  })
  it('keeps empty-query behavior and shows the latest question while results settle', () => {
    expect(searchPalette(commands, [meeting], '   ').rows[0]).toEqual({ kind: 'meeting', meeting })
    const pending = searchPalette(commands, [meeting], '', 'new question?')
    expect(pending.rows[0]).toEqual({ kind: 'ask', query: 'new question?' })
    expect(pending.active).toBe(0)
  })
})


it('keeps a strong selection through pending keystrokes, while questions stay on Ask', () => {
  const meeting = { confident: true }
  for (const [settled, typed] of [['t', 'th'], ['th', 'the'], ['the', 'them'], ['them', 'theme'], ['theme', 'them']]) {
    const before = searchPalette(commands, [meeting], settled)
    const pending = searchPalette(commands, [meeting], settled, typed)
    expect(pending.rows[pending.active]).toEqual(before.rows[before.active])
  }
  expect(searchPalette(commands, [meeting], 'theme', 'what is theme').active).toBe(0)
  expect(searchPalette(commands, [meeting], 'what is', 'what is next').active).toBe(0)
})

it('offers people as choices without turning partial names into filters', () => {
  const choice = { person: { name: 'Riley Example', email: 'riley@example.test' }, start: 0, end: 3 }
  const result = searchPalette(commands, [], 'Ril', 'Ril', [choice])
  expect(result.rows.map(r => r.kind)).toEqual(['person'])
  expect(result.rows[0]).toEqual({ kind: 'person', ...choice })
  expect(result.active).toBe(0)
})

describe('default selection settling', () => {
  const meeting = { meetingId: 'planning', confident: true }
  const choose = (query: string, previous?: string, meetings = [meeting]) => {
    const palette = searchPalette(commands, meetings, query, query, [], previous)
    return palette.rows[palette.active] && searchSelectionKey(palette.rows[palette.active])
  }

  it('keeps folder ties in command order and settles successive queries like the palette', () => {
    const source = [commands[0], commands[1], commands[7], commands[4], commands[3]]
    let previous: string | undefined, completed = ''
    for (const [query, expected] of [
      ['', 'meeting:planning'], ['dark', 'command:Dark planning'], ['light', 'command:Light theme'],
      ['set', 'command:Settings'], ['trash', 'command:Trash'], ['budget review', 'meeting:planning'],
      ['theme', 'meeting:planning'], ['mode', 'meeting:planning'], ['', 'meeting:planning'],
      ['dark', 'command:Dark planning'],
    ]) {
      const pending = searchPalette(source, [meeting], completed, query, [], previous)
      if (!query) previous = undefined
      else if (completed) expect(pending.rows.length).toBeGreaterThan(0)
      const settled = searchPalette(source, [meeting], query, query, [], previous)
      expect(searchSelectionKey(settled.rows[settled.active])).toBe(expected)
      previous = query ? searchSelectionKey(settled.rows[settled.active]) : undefined
      completed = query
    }
  })

  it('keeps the current choice on a near-tie, even when row positions change', () => {
    expect(choose('dark', 'meeting:planning')).toBe('meeting:planning')
    expect(choose('mode', 'command:Dark theme')).toBe('command:Dark theme')
  })

  it('lets a clearly better match take over', () => {
    expect(choose('dark theme', 'meeting:planning')).toBe('command:Dark theme')
    expect(choose('theme', 'ask')).toBe('command:Dark theme')
    expect(choose('budget', 'ask')).toBe('meeting:planning')
  })

  it('resets a cleared query to the first row', () => {
    expect(choose('', 'command:Dark theme')).toBe('meeting:planning')
    expect(choose('   ', 'ask')).toBe('meeting:planning')
  })

  it('keeps the theme choice through successive keystrokes and pending searches', () => {
    let previous: string | undefined
    for (const query of ['t', 'th', 'the', 'them', 'theme']) {
      const palette = searchPalette([commands[3]], [meeting], query, query, [], previous)
      previous = searchSelectionKey(palette.rows[palette.active])
      expect(previous).toBe('command:Dark theme')
      const pending = searchPalette([commands[3]], [meeting], query, `${query}e`, [], previous)
      expect(searchSelectionKey(pending.rows[pending.active])).toBe(previous)
    }
  })

  it('selects Ask for questions and discards vanished previous selections', () => {
    expect(choose('what is dark theme?', 'command:Dark theme')).toBe('ask')
    expect(choose('unfindable', 'command:Dark theme', [])).toBeUndefined()
    expect(choose('budget', 'meeting:planning', [{ ...meeting, confident: false }])).toBe('meeting:planning')
  })
})
