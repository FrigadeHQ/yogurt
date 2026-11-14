import { t, language } from '../../shared/i18n'
import type { Person } from '../../shared/types'
import type { SearchPersonMatch } from '../../shared/searchPeople'
import type { SearchDate } from '../../shared/searchQuery'

export function searchDateCommand(date: SearchDate | undefined, query: string) {
  if (!date) return undefined
  const start = new Date(date.start)
  if (new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1).getTime() !== date.end) return undefined
  return { id: 'agenda-date', query, group: t('Go to'), label: t('Go to {date}', {
    date: new Intl.DateTimeFormat(language(), { month: 'short', day: 'numeric', year: 'numeric' }).format(start),
  }), at: date.start }
}

export function searchDateLabel(date: SearchDate, locale = language()) {
  const start = new Date(date.start)
  const singleDay = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1).getTime() === date.end
  return new Intl.DateTimeFormat(locale, singleDay
    ? { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' }).formatRange(date.start, date.end - 1)
}

/** Spans refer to the original input; only the search terms are stripped for matching. */
export function searchFilterHighlights(query: string, people: SearchPersonMatch[], date?: { start: number; end: number }) {
  const spans = [...people.map(p => ({ start: p.start, end: p.end, kind: 'person' as const })),
    ...(date ? [{ ...date, kind: 'date' as const }] : [])].sort((a, b) => a.start - b.start)
  const parts: { text: string; kind?: 'person' | 'date' }[] = []
  let end = 0
  for (const span of spans) {
    if (span.start > end) parts.push({ text: query.slice(end, span.start) })
    parts.push({ text: query.slice(span.start, span.end), kind: span.kind })
    end = span.end
  }
  if (end < query.length) parts.push({ text: query.slice(end) })
  return parts
}

export function searchFilterEmptyMessage(people: Person[], date?: string) {
  const name = new Intl.ListFormat(language(), { type: 'conjunction' }).format(people.map(p => p.name || p.email || ''))
  if (name && date) return t('No matching meetings with {name} on {date}.', { name, date })
  if (name) return t('No matching meetings with {name}.', { name })
  if (date) return t('No matching meetings on {date}.', { date })
  return undefined
}
