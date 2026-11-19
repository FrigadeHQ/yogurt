import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOCALES, type Entry } from '../src/shared/i18n'
// @ts-expect-error plain JS script
import { i18nKeys } from '../scripts/i18n-keys.mjs'

const keys: string[] = i18nKeys()
const dir = join(__dirname, '../src/shared/locales')
const load = (id: string): Record<string, Entry> => JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'))
const blanks = (s: string) => [...new Set(s.match(/\{\w+\}/g) ?? [])].sort()
const forms = (e: Entry) => (typeof e === 'string' ? [e] : Object.values(e))

it('translates summary cancellation and its restart state in every locale', () => {
  for (const { id } of LOCALES) for (const key of ['Stop summary', 'Summary stopped.', 'Generate summary']) {
    expect(keys).toContain(key)
    if (id === 'en' && key === 'Generate summary') continue
    expect(load(id)[key]).toBeTypeOf('string')
    expect(load(id)[key]).not.toBe('')
    if (id !== 'en') expect(load(id)[key]).not.toBe(key)
  }
})

it('translates the app location choice and removes the old Mac toggle labels', () => {
  for (const { id } of LOCALES) {
    const table = load(id)
    for (const key of ['Show Yogurt in', 'Menu bar and Dock', 'Menu bar only', 'Dock only']) {
      expect(keys).toContain(key)
      expect(table[key]).toBeTypeOf('string')
      expect(table[key]).not.toBe('')
      if (id !== 'en') expect(table[key]).not.toBe(key)
    }
    for (const key of ['Show Yogurt in the menu bar', 'Show Yogurt in the Dock']) {
      expect(keys).not.toContain(key)
      expect(table).not.toHaveProperty(key)
    }
  }
})

it('translates the summary waiting label in every locale', () => {
  const key = 'Reading the transcript…'
  expect(keys).toContain(key)
  for (const { id } of LOCALES) {
    expect(load(id)[key]).toBeTypeOf('string')
    expect(load(id)[key]).not.toBe('')
    if (id !== 'en') expect(load(id)[key]).not.toBe(key)
  }
})

it('translates the agenda date command in every locale', () => {
  const key = 'Go to {date}'
  expect(keys).toContain(key)
  for (const { id } of LOCALES) {
    expect(load(id)[key]).toBeTypeOf('string')
    expect(load(id)[key]).toContain('{date}')
    if (id !== 'en') expect(load(id)[key]).not.toBe(key)
  }
})

it('translates day arrows and removes unused week arrows in every locale', () => {
  for (const { id } of LOCALES) {
    const table = load(id)
    for (const key of ['Previous day', 'Next day']) {
      expect(keys).toContain(key)
      expect(table[key]).toBeTypeOf('string')
      expect(table[key]).not.toBe('')
      if (id !== 'en') expect(table[key]).not.toBe(key)
    }
    for (const key of ['Previous week', 'Next week']) {
      expect(keys).not.toContain(key)
      expect(table).not.toHaveProperty(key)
    }
  }
})

it('translates agenda marker labels in every locale', () => {
  for (const { id } of LOCALES) {
    const table = load(id)
    for (const key of ['Recording', 'Paused', 'Has notes']) {
      expect(keys).toContain(key)
      if (id !== 'en') {
        expect(table[key]).toBeTypeOf('string')
        expect(table[key]).not.toBe('')
        expect(table[key]).not.toBe(key)
      }
    }
    expect(table).not.toHaveProperty('In progress')
  }
})

it('translates the contextual recording action and menu timing in every locale', () => {
  for (const { id } of LOCALES) {
    const table = load(id)
    for (const key of ['Take notes · {title}', 'Resume notes · {title}', 'Take notes · {count} now', 'Now', 'in {count} min']) {
      expect(keys).toContain(key)
      expect(table[key]).toBeDefined()
      expect(forms(table[key]).every(value => value.trim().length > 0)).toBe(true)
      if (id !== 'en') expect(forms(table[key])).not.toContain(key)
    }
  }
})

it('uses Ask and conversations throughout the interface', () => {
  // Chat names the fresh-conversation action and selected scope group; the page remains Ask.
  expect(keys.filter(key => /\bchats?\b/i.test(key))).toEqual(['In this chat', 'New chat'])
  expect(keys).toContain('Ask')
  expect(keys).toContain('Conversations')
})

it('names the AI download directly in every locale', () => {
  for (const { id } of LOCALES) {
    const table = load(id)
    for (const key of ['Downloading AI', 'Downloading AI · {percent}', 'AI download stopped', 'Upgrading AI', 'Upgrading AI · {percent}', 'AI upgrade paused']) {
      expect(keys).toContain(key)
      expect(table[key]).toBeTypeOf('string')
    }
    expect(Object.keys(table).filter(key => key.startsWith('Setting up notes') || key === "Couldn't download notes")).toEqual([])
  }
})

it('translates the popover readout and support in every locale', () => {
  for (const { id } of LOCALES) {
    const table = load(id)
    for (const key of [
      'Download stopped', 'Upgrade paused', 'about {minutes} min left',
      'You can record meetings. AI summaries and Ask work when this finishes.',
      "Once this model is ready, we'll remove the old one.",
    ]) {
      expect(keys).toContain(key)
      expect(table[key]).toBeTypeOf('string')
      expect(table[key]).not.toBe('')
      if (id !== 'en') expect(table[key]).not.toBe(key)
    }
  }
  expect(keys).not.toContain('Next, a better notes model ({size} GB) downloads in the background.')
})

it('keeps checklist Close separate from Hide checklist in every locale', () => {
  for (const { id } of LOCALES.filter(l => l.id !== 'en')) {
    const table = load(id)
    for (const key of ['More', 'Close', 'Hide checklist']) expect(table[key]).toBeTypeOf('string')
    expect(table.Close).not.toBe(table['Hide checklist'])
  }
})

it('explains the notes model benefit and removal in every locale', () => {
  for (const { id } of LOCALES) {
    const table = load(id)
    for (const key of [
      "More detailed, accurate notes. Replaces the current model, so you don't keep both.",
      'Removing this model restores the smaller one.',
      'Getting the smaller model · {progress}',
      'The larger model keeps running summaries and Ask until then, and is removed after.',
      'Removing…',
    ]) {
      expect(keys).toContain(key)
      expect(table[key]).toBeTypeOf('string')
      if (id !== 'en') expect(table[key]).not.toBe(key)
    }
  }
})

it('translates the skipped-model toast and Settings action in every locale', () => {
  for (const { id } of LOCALES) {
    const table = load(id)
    for (const key of ['AI upgrade skipped', 'Settings']) {
      expect(keys).toContain(key)
      expect(table[key]).toBeTypeOf('string')
      expect(table[key]).not.toBe('')
      // Filipino keeps the word Settings as macOS does
      if (id !== 'en' && !(id === 'fil' && key === 'Settings')) expect(table[key]).not.toBe(key)
    }
  }
})

describe('English', () => {
  const en = load('en')
  it('has both forms for every text with a count', () => {
    const counted = keys.filter((k) => k.includes('{count}'))
    expect(counted.filter((k) => typeof en[k] !== 'object' || !en[k].one || !en[k].other)).toEqual([])
  })
  it('keeps no forms for text the app no longer shows', () => {
    expect(Object.keys(en).filter((k) => !keys.includes(k))).toEqual([])
  })
})

describe.each(LOCALES.filter((l) => l.id !== 'en'))('$english', ({ id }) => {
  it('has a table', () => expect(existsSync(join(dir, `${id}.json`))).toBe(true))
  it('translates Ask rather than using the English label', () => {
    expect(load(id).Ask).not.toBe('Ask')
  })
  const table = existsSync(join(dir, `${id}.json`)) ? load(id) : {}
  it('translates everything the app shows', () => {
    expect(keys.filter((k) => !(k in table))).toEqual([])
  })
  it('keeps nothing the app no longer shows', () => {
    expect(Object.keys(table).filter((k) => !keys.includes(k))).toEqual([])
  })
  it('keeps every blank, and leaves none empty', () => {
    const wrong = Object.entries(table).filter(([k, v]) => {
      if (typeof v !== 'string' && !v.other) return true
      if (forms(v).some((f) => !f.trim())) return true
      const other = typeof v === 'string' ? v : v.other!
      // a singular form may say "one" instead of {count}
      return blanks(other).join() !== blanks(k).join() || forms(v).some((f) => blanks(f).some((b) => !blanks(k).includes(b)))
    }).map(([k]) => k)
    expect(wrong).toEqual([])
  })
})

it('translates recording deletion and retention in every locale', () => {
  for (const { id } of LOCALES) for (const old of ['Delete recording', 'Delete recording?', "Yogurt couldn't delete the recording.", 'Keep recordings after meetings', 'Turn off to delete audio after the transcript and summary are saved.', 'Only applies to meetings that finish from now on.']) expect(load(id)[old]).toBeUndefined()
  for (const { id } of LOCALES) for (const key of ["Recording deleted", "Settings", "Delete audio", "Delete audio?", "The audio is deleted for good. Your transcript and notes stay.", "Keep the audio until the transcript is saved.", "Yogurt couldn't delete the audio.", "Keep audio recordings after meetings", "When off, new meetings' audio is deleted once the summary is saved."]) {
    expect(keys).toContain(key)
    expect(load(id)[key]).toBeTypeOf('string')
    if (id !== 'en' && !(id === 'fil' && key === 'Settings')) expect(load(id)[key]).not.toBe(key)
  }
})

it('translates the context selector search in every locale', () => {
  for (const key of ['Search…', 'Search meetings and folders']) {
    expect(keys).toContain(key)
    for (const { id } of LOCALES) {
      expect(load(id)[key]).toBeTypeOf('string')
      expect(load(id)[key]).not.toBe('')
      if (id !== 'en') expect(load(id)[key]).not.toBe(key)
    }
  }
})

it('translates additional context results and their singular form', () => {
  const key = '{count} more results'
  expect(keys).toContain(key)
  for (const { id } of LOCALES) {
    const entry = load(id)[key]
    expect(entry).toBeDefined()
    expect(forms(entry).every(value => value.trim().length > 0)).toBe(true)
    if (id !== 'en') expect(forms(entry)).not.toContain(key)
  }
  expect(load('en')[key]).toEqual({ one: '{count} more result', other: key })
})


it('translates scope labels and actions in every locale', () => {
  for (const key of ['All meetings', 'Choose meetings or folders', 'In this chat', 'and {count} others', '{count} more', 'Clear']) {
    expect(keys).toContain(key)
    for (const { id } of LOCALES) {
      expect(load(id)[key]).toBeDefined()
      if (id !== 'en') expect(forms(load(id)[key])).not.toContain(key)
    }
  }
  expect(load('en')['and {count} others']).toEqual({ one: 'and {count} other', other: 'and {count} others' })
})


it('translates the closest matching meeting and count in every locale', () => {
  const key = 'Reading {title} {others}…'
  expect(keys).toContain(key)
  for (const { id } of LOCALES) {
    if (id === 'en') continue
    expect(load(id)[key]).toBeTypeOf('string')
    expect(load(id)[key]).not.toBe(key)
    expect(load(id)[key]).toContain('{title}')
    expect(load(id)[key]).toContain('{others}')
  }
})


it('translates the searched scope line in every locale', () => {
  for (const key of ['Searched all meetings', 'Searched {name}']) {
    expect(keys).toContain(key)
    for (const { id } of LOCALES) {
      expect(load(id)[key]).toBeTypeOf('string')
      expect(load(id)[key]).not.toBe('')
      if (id !== 'en') expect(load(id)[key]).not.toBe(key)
    }
  }
})

it('translates the summary language setting in every locale', () => {
  for (const key of ['Summary language', 'Same as the meeting', 'Used for new summaries and when you write them again.']) {
    expect(keys).toContain(key)
    for (const { id } of LOCALES) {
      expect(load(id)[key]).toBeTypeOf('string')
      expect(load(id)[key]).not.toBe('')
      if (id !== 'en') expect(load(id)[key]).not.toBe(key)
    }
  }
})

it('translates the ungrouped people heading in every locale', () => {
  expect(keys).toContain('Other people')
  for (const { id } of LOCALES) {
    expect(load(id)['Other people']).toBeTypeOf('string')
    expect(load(id)['Other people']).not.toBe('')
    if (id !== 'en') expect(load(id)['Other people']).not.toBe('Other people')
  }
})

it('translates transcript match counts and navigation in every locale', () => {
  for (const { id } of LOCALES) {
    for (const key of ['{current} of {count}', 'No matches', 'Previous match', 'Next match']) {
      expect(keys).toContain(key)
      const entry = load(id)[key]
      expect(entry).toBeDefined()
      expect(forms(entry).every(value => value.trim().length > 0)).toBe(true)
      if (id !== 'en') expect(forms(entry)).not.toContain(key)
    }
  }
})


it('translates both citation destinations in every locale', () => {
  for (const { id } of LOCALES) for (const key of ['Open in transcript', 'Open note']) {
    expect(keys).toContain(key)
    expect(load(id)[key]).toBeTypeOf('string')
    expect(load(id)[key]).not.toBe('')
    if (id !== 'en') expect(load(id)[key]).not.toBe(key)
  }
})
