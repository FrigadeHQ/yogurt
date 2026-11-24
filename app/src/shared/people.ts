import type { Person } from './types'
export const ownAddress = (value: unknown): string | null => typeof value === 'string' && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value.trim()) ? value.trim().toLowerCase() : null
/** Only an address already identified as ours can fill an unlinked note's self row. */
export function matchingOwnEmail(people: Person[], emails: string[]): string | null {
  const domains = new Set(people.map(p => ownAddress(p.email)?.split('@')[1]).filter(Boolean))
  return emails.map(ownAddress).filter((email): email is string => !!email).sort().find(email => domains.has(email.split('@')[1])) ?? null
}

export const personEmail = (email: string) => email.trim().toLowerCase()
export const attendeePrivacy = (focused: boolean, text: string) => focused || text.includes('@')
const membershipPrefix = 'members:'
function membership(keys: string[]) {
  const normalized = keys.map(key => key.startsWith('name:') ? 'name:' + key.slice(5).trim().replace(/\s+/g, ' ').toLowerCase() : key)
  return membershipPrefix + JSON.stringify([...new Set(normalized)].sort())
}
export const attendeeMembership = (people: Person[]) => membership(people.map(p => p.email?.trim() ? `email:${personEmail(p.email)}` : `name:${p.name}`))

/** Older fingerprints kept duplicate identities and the original spelling of names. */
function normalizedMembership(value: string) {
  if (value.startsWith(membershipPrefix)) {
    try {
      const keys: unknown = JSON.parse(value.slice(membershipPrefix.length))
      if (Array.isArray(keys) && keys.every(key => typeof key === 'string')) return membership(keys)
    } catch { /* Keep an unrecognized baseline as recorded. */ }
  }
  return value
}
export const sameAttendeeMembership = (a: string | null, b: string) => a === b || (a != null && normalizedMembership(a) === normalizedMembership(b))
export function emailName(email: string): string {
  const local = email.split('@')[0], name = local.replace(/[._-]+/g, ' ').trim() || local
  return name.charAt(0).toUpperCase() + name.slice(1)
}
// A seen name only echoes the address when it matches the fallback and has no real capitalization of its own.
const echoesEmail = (n: string, fallback: string) => n.toLowerCase() === fallback.toLowerCase() && (n === fallback || n === n.toLowerCase() || n === n.toUpperCase())
export function resolvedPersonName(email: string, display: string | null, seen: string[]): string {
  if (display) return display
  const fallback = emailName(email)
  const names = seen.filter(n => n.trim() && !n.includes('@') && !echoesEmail(n, fallback))
  // Prefer full names, then a longer name; ties keep the first observation.
  names.sort((a, b) => b.trim().split(/\s+/).length - a.trim().split(/\s+/).length || b.length - a.length)
  return names[0] || fallback
}

// shortcut: company labels use domain text, use verified organization metadata when available.
export function groupPeople<Row extends { p: Person }>(rows: Row[]) {
  const groups = new Map<string, { domain: string; label: string; people: Row[] }>()
  const personal = new Set(['gmail.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'yahoo.com', 'proton.me', 'protonmail.com', 'mail.example'])
  for (const row of rows) {
    const email = row.p.email?.trim().toLowerCase() ?? ''
    const match = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/.exec(email)
    const domain = match && !personal.has(match[1]) ? match[1] : ''
    const label = domain ? domain.split('.')[0].replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : ''
    if (!groups.has(domain)) groups.set(domain, { domain, label, people: [] })
    groups.get(domain)!.people.push(row)
  }
  return [...groups.values()].sort((a, b) => !a.domain ? 1 : !b.domain ? -1 : a.label.localeCompare(b.label))
}

export function initials(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).filter((_, i, a) => i === 0 || i === a.length - 1).map(s => Array.from(s)[0]).join('').toLocaleUpperCase()
}
