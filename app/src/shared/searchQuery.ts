import { casual as en, GB, type Chrono } from 'chrono-node/en'
import { casual as de } from 'chrono-node/de'
import { casual as fr } from 'chrono-node/fr'
import { casual as ja } from 'chrono-node/ja'
import { casual as pt } from 'chrono-node/pt'
import { casual as nl } from 'chrono-node/nl'
import { casual as ru } from 'chrono-node/ru'
import { casual as es } from 'chrono-node/es'
import { casual as uk } from 'chrono-node/uk'
import { casual as it } from 'chrono-node/it'
import { casual as sv } from 'chrono-node/sv'
import { casual as fi } from 'chrono-node/fi'
import { casual as vi } from 'chrono-node/vi'
import { casual as id } from 'chrono-node/id'
import { casual as ar } from 'chrono-node/ar'
import { casual as hans } from 'chrono-node/zh/hans'
import { casual as hant } from 'chrono-node/zh/hant'
import type { ParsedComponents } from 'chrono-node'
import type { Person } from './types'
export type SearchDate = { start: number; end: number }
export type SearchOptions = { now?: Date; locale?: string; language?: string; people?: Person[] }
const stopWords = new Set(['with', 'about', 'from', 'on', 'the', 'a', 'and', 'meeting'])
export const searchWords = (text: string) => text.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w && !stopWords.has(w))
const parsers: Record<string, Chrono> = { en, de, fr, ja, pt, nl, ru, es, uk, it, sv, fi, vi, id, ar, 'zh-cn': hans, 'zh-tw': hant }

/** Calendar boundaries use local dates, including days that are not 24 hours long. */
export function parseSearchQuery(query: string, { now = new Date(), locale = new Intl.DateTimeFormat().resolvedOptions().locale, language = locale }: SearchOptions = {}) {
  let date: SearchDate | undefined
  let dateSpan: { start: number; end: number } | undefined
  let text = query
  const day = (offset = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
  const consume = (span: { start: number; end: number }, start: Date, end: Date) => {
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return
    date = { start: start.getTime(), end: end.getTime() }
    dateSpan = span
    text = (query.slice(0, span.start) + ' ' + query.slice(span.end)).replace(/\s+/g, ' ').trim()
  }
  const period = /\b(?:(this|last) (week|month)|(past|last) (\d+) (days?|weeks?))\b/i.exec(query)
  if (period) {
    let start: Date, end: Date
    if (period[4]) {
      // Rolling ranges include today: the past seven days are seven local calendar days.
      const count = Number(period[4]) * (period[5].toLowerCase().startsWith('week') ? 7 : 1)
      start = day(1 - count); end = day(1)
    } else if (period[2].toLowerCase() === 'month') {
      const offset = period[1].toLowerCase() === 'last' ? -1 : 0
      start = new Date(now.getFullYear(), now.getMonth() + offset, 1)
      end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 1)
    } else {
      const info = new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } }
      const first = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay ?? 1
      const offset = -((now.getDay() - first + 7) % 7) - (period[1].toLowerCase() === 'last' ? 7 : 0)
      start = day(offset); end = day(offset + 7)
    }
    consume({ start: period.index, end: period.index + period[0].length }, start, end)
  } else {
    const fields = new Intl.DateTimeFormat(locale).formatToParts(new Date(2001, 10, 22)).map(p => p.type)
    const dayFirst = fields.indexOf('day') < fields.indexOf('month')
    const lang = language.toLowerCase()
    let parser = parsers[lang] ?? parsers[lang.split('-')[0]] ?? en
    if (parser === en && dayFirst) parser = GB
    const midnight = (c: ParsedComponents) => new Date(c.get('year')!, c.get('month')! - 1, c.get('day')!)
    for (const result of parser.parse(query, now)) {
      const start = midnight(result.start), last = midnight(result.end ?? result.start)
      const span = { start: result.index, end: result.index + result.text.trimEnd().length }
      const before = query.slice(0, span.start)
      const monthOnly = result.start.isCertain('month') && !result.start.isCertain('day')
      const weekdayOnly = result.start.isCertain('weekday') && !result.start.isCertain('day')
      const inMonth = /\bin\s+$/i.exec(before)
      if (monthOnly) {
        if (!inMonth || result.end) continue
        span.start = inMonth.index
      } else if (weekdayOnly) {
        // A bare weekday within other words may be a title; standalone weekdays and explicit modifiers are dates.
        const on = /\bon\s+$/i.exec(before)
        if (on) span.start = on.index
        else if (/^\p{L}+\.?$/u.test(result.text.trim()) && query.trim() !== result.text.trim()) continue
        if (start > day() && !/\b(next|this)\b/i.test(result.text)) {
          start.setDate(start.getDate() - 7); last.setDate(last.getDate() - 7)
        }
      } else if (!result.start.isCertain('day')) continue
      if (parser === en || parser === GB) {
        // Chrono accepts swapped numeric fields; keep the user's regional month/day order unambiguous.
        const numeric = [...result.text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{4})?\b/g)]
        if (numeric.some(m => Number(m[dayFirst ? 2 : 1]) > 12)) continue
      }
      if (result.start.isCertain('month') && !result.start.isCertain('year') && !result.end?.isCertain('year') && start > day()) {
        const month = start.getMonth(), lastMonth = last.getMonth()
        start.setFullYear(start.getFullYear() - 1); last.setFullYear(last.getFullYear() - 1)
        if (start.getMonth() !== month || last.getMonth() !== lastMonth) continue
      }
      if (result.end) {
        const from = /\bfrom\s+$/i.exec(before)
        if (from) span.start = from.index
      }
      const end = monthOnly ? new Date(start.getFullYear(), start.getMonth() + 1, 1)
        : new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1)
      consume(span, start, end)
      if (date) break
    }
  }
  return { text, words: searchWords(text), date, ...(dateSpan ? { dateSpan } : {}) }
}

/** A single insertion, deletion or substitution; short words stay exact. */
export function oneEdit(a: string, b: string): boolean {
  if (a.length < 5 || Math.abs(a.length - b.length) > 1) return false
  let i = 0, j = 0, edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue }
    if (++edits > 1) return false
    if (a.length >= b.length) i++
    if (b.length >= a.length) j++
  }
  return edits + Number(i < a.length || j < b.length) <= 1
}
