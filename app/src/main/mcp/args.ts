/**
 * What another app's model sends is checked strictly before Yogurt acts on it: a wrong type, a value too long or a
 * list too big is refused in plain words the model can act on, never half-done. Text here goes to that model, in English.
 */

/** a plain answer for the other app's model, not a crash: handle() turns it into an error result */
export class Refusal extends Error {}

export type Args = Record<string, unknown>

/** text, trimmed; undefined when left out. Wrong type, blank (when required) or too long is refused. */
export function str(a: Args, key: string, o: { max: number; required?: boolean; keepSpace?: boolean }): string | undefined {
  const v = a[key]
  if (v === undefined || v === null) {
    if (o.required) throw new Refusal(`${key} is needed.`)
    return undefined
  }
  if (typeof v !== 'string') throw new Refusal(`${key} must be text.`)
  const s = o.keepSpace ? v : v.trim()
  if (o.required && !s.trim()) throw new Refusal(`${key} can't be blank.`)
  if (s.length > o.max) throw new Refusal(`${key} is too long: at most ${o.max} characters.`)
  return s
}

export function bool(a: Args, key: string): boolean | undefined {
  const v = a[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') throw new Refusal(`${key} must be true or false.`)
  return v
}

/** one of a few words */
export function oneOf<T extends string>(a: Args, key: string, values: readonly T[]): T | undefined {
  const v = a[key]
  if (v === undefined || v === null) return undefined
  if (!values.includes(v as T)) throw new Refusal(`${key} must be one of: ${values.map((x) => JSON.stringify(x)).join(', ')}.`)
  return v as T
}

export function list(a: Args, key: string, o: { max: number; required?: boolean }): unknown[] | undefined {
  const v = a[key]
  if (v === undefined || v === null) {
    if (o.required) throw new Refusal(`${key} is needed.`)
    return undefined
  }
  if (!Array.isArray(v)) throw new Refusal(`${key} must be a list.`)
  if (v.length > o.max) throw new Refusal(`${key} has ${v.length} items: at most ${o.max} in one call.`)
  return v
}

/** an ISO time (or a date) as ms; refused when it isn't one */
export function time(a: Args, key: string, o: { required?: boolean } = {}): number | undefined {
  const s = str(a, key, { max: 64, required: o.required })
  if (s === undefined) return undefined
  const ms = Date.parse(s)
  if (!Number.isFinite(ms)) throw new Refusal(`${key} must be an ISO time, like 2026-11-03T15:00:00Z.`)
  return ms
}

/** "2026-11-03" is that day where the person is (midday, so no time zone moves it a day); a full ISO time is its own day */
export function day(a: Args, key: string, o: { required?: boolean } = {}): number | undefined {
  const s = str(a, key, { max: 64, required: o.required })
  if (s === undefined) return undefined
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  const ms = ymd ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]), 12).getTime() : Date.parse(s)
  if (!Number.isFinite(ms)) throw new Refusal(`${key} must be a date, like 2026-11-03.`)
  return ms
}

/** a person, as other apps give them: a name, and an email when they know it */
export function people(v: unknown[], key: string): Array<{ name: string; email: string | null }> {
  return v.map((p, i) => {
    if (!p || typeof p !== 'object') throw new Refusal(`${key}[${i}] must be an object with a name (and an email if known).`)
    const name = str(p as Args, 'name', { max: 200, required: true })!
    const email = str(p as Args, 'email', { max: 200 })
    return { name, email: email || null }
  })
}
