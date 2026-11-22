import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { language, moreItems, setLanguage } from '../src/shared/i18n'
import type { Meeting } from '../src/shared/types'
import { describe, expect, it } from 'vitest'
import { People, parsePerson, peopleSummary, peopleChipSummary, personName } from '../src/renderer/src/components/People'

describe('people on a note', () => {
  it('reads a name, a name and email, or an email alone', () => {
    expect(parsePerson('  Maya   Chen ')).toEqual({ name: 'Maya Chen', email: null })
    expect(parsePerson('Maya Chen <maya@x.com>')).toEqual({ name: 'Maya Chen', email: 'maya@x.com' })
    expect(parsePerson('Maya Chen maya@x.com')).toEqual({ name: 'Maya Chen', email: 'maya@x.com' })
    expect(parsePerson('maya@x.com')).toEqual({ name: 'maya@x.com', email: 'maya@x.com' })
    expect(parsePerson('   ')).toBeNull()
  })
  it('keeps email identity but uses a name in the visible record and compact label', () => {
    expect(personName('Maya Chen <maya@example.com>')).toBe('Maya Chen')
    expect(personName('maya.chen@example.com')).toBe('Maya chen')
    expect(personName('...@example.com')).toBe('...')
    expect(parsePerson('maya.chen@example.com')?.email).toBe('maya.chen@example.com')
    expect(peopleSummary([{ name: 'maya.chen@example.com', email: 'maya.chen@example.com' }], 'Sam Rivera')).toBe('Maya')
  })
  it('caps compact labels at three first names, never counting the person themself', () => {
    const p = (name: string) => ({ name, email: null })
    expect(peopleSummary([], 'Sam Rivera')).toBe('Me')
    expect(peopleSummary([p('sam rivera')], 'Sam Rivera')).toBe('Me')
    expect(peopleSummary([p('Ann Lee')], 'Sam Rivera')).toBe('Ann')
    expect(peopleSummary([p('Ann Lee'), p('Bo Park')], 'Sam Rivera')).toBe('Ann, Bo')
    expect(peopleSummary([p('Ann Lee'), p('Bo Park'), p('Cy Ho')], 'Sam Rivera')).toBe('Ann, Bo, Cy')
    expect(peopleSummary([p('Ann Lee'), p('Sam Rivera'), p('Bo Park'), p('Cy Ho'), p('Di Wu')], 'Sam Rivera')).toBe('Ann, Bo, Cy and 1 more')
    expect(peopleSummary(['Sam Rivera', 'Ann Lee', 'Bo Park', 'Cy Ho', 'Di Wu', 'Eli Grey', 'Finn Day', 'Gia Ray', 'Hal Kim'].map(p), 'Sam Rivera')).toBe('Ann, Bo, Cy and 5 more')
    expect(peopleSummary(Array.from({ length: 40 }, (_, i) => p(`Guest${i + 1} Family`)), 'Sam Rivera')).toBe('Guest1, Guest2, Guest3 and 37 more')
  })
})

it('the people chip uses two first names, excludes me and invites adding to an empty list', () => {
  const p = (name: string) => ({ name, email: null })
  expect(peopleChipSummary([], 'Sam Rivera').label).toBe('Add attendees')
  expect(peopleChipSummary([p(' sam rivera ')], 'Sam Rivera').label).toBe('Add attendees')
  expect(peopleChipSummary([p('Jamie Quill')], 'Sam Rivera').label).toBe('Jamie')
  expect(peopleChipSummary(['Jamie Quill', 'Sam Rivera', 'Bo Park'].map(p), 'Sam Rivera').label).toBe('Jamie, Bo')
  expect(peopleChipSummary(['Jamie Quill', 'Bo Park', 'Ann Lee'].map(p), 'Sam Rivera')).toEqual({ names: 'Jamie, Bo', more: 1, label: 'Jamie, Bo and 1 more' })
})

it.each([
  ['en', 1, 'and 1 more'], ['fi', 1, 'ja 1 muu'], ['fi', 3, 'ja 3 muuta'],
  ['ar', 1, 'وواحد آخر'], ['ar', 2, 'واثنان آخران'], ['ar', 3, `و${new Intl.NumberFormat('ar').format(3)} آخرين`],
  ['it', 1, 'e un altro'], ['it', 3, 'e altri 3'], ['he', 12, 'ועוד 12'],
] as const)('keeps the visual +N left-to-right and speaks the local count in %s (%i)', (locale, more, phrase) => {
  const initial = language()
  try {
    setLanguage(locale)
    const attendees = ['דנה', 'Bo', ...Array(more).fill('Jo')].map(name => ({ name, email: null }))
    const { names, label } = peopleChipSummary(attendees, '')
    expect(label).toBe(`${names} ${phrase}`)
    const html = renderToStaticMarkup(createElement(People, { m: { attendees } as Meeting }))
    expect(html).toContain(`aria-label="${label}"`)
    expect(html).toContain(`${names} <bdi dir="ltr">+${more}</bdi>`)
  } finally { setLanguage(initial) }
})

it('uses the Japanese counter for the kind of list', () => {
  const initial = language()
  try {
    setLanguage('ja')
    const attendees = ['A', 'B', 'C', 'D'].map(name => ({ name, email: null }))
    expect(peopleSummary(attendees, '')).toMatch(/ほか1人$/)
    expect(moreItems(1)).toBe('と他 1 件')
  } finally { setLanguage(initial) }
})
