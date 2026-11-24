import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { inspect } from 'node:util'

/** One line per message: time, level, then the message (errors with their stack). */
export function logLine(level: string, args: unknown[], at = new Date()): string {
  return `${at.toISOString()} ${level} ${args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack ?? String(a) : inspect(a, { depth: 3 }))).join(' ')}\n`
}

/** main.log's previous file, next to it (main.old.log) */
export const oldLogFile = (file: string): string => file.replace(/(\.log)?$/, '.old$1')

/**
 * Append, keeping the file under cap bytes: past it, the file becomes main.old.log (replacing the one before) and a new
 * one starts. Two files are kept, so a morning's trouble is still there in the afternoon (#156: dropping the older half
 * of one file lost it).
 */
export function writeLog(file: string, line: string, cap = 4_000_000) {
  mkdirSync(dirname(file), { recursive: true })
  if (existsSync(file) && statSync(file).size + line.length > cap) renameSync(file, oldLogFile(file))
  appendFileSync(file, line)
}

/**
 * Warnings, errors and info (where a reply's time went) also go to a file in the profile (logs/main.log, and the one
 * before it, logs/main.old.log), so a problem on someone's computer can be looked at afterwards; nothing leaves the computer.
 */
export function logToFile(file: string) {
  for (const level of ['info', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      try { writeLog(file, logLine(level, args)) } catch { /* never let logging break the app */ }
    }
  }
}
