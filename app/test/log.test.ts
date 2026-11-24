import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { logLine, oldLogFile, writeLog } from '../src/main/log'

it('a log line has the time, the level and the error with its stack', () => {
  const line = logLine('error', ['web search failed', new Error('connect ECONNREFUSED')], new Date('2026-10-22T20:00:00Z'))
  expect(line).toMatch(/^2026-10-22T20:00:00.000Z error web search failed Error: connect ECONNREFUSED\n\s+at /)
})

it('the log file never grows past its cap', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'yogurt-log-')), 'main.log')
  writeFileSync(file, 'x'.repeat(900))
  writeLog(file, 'y'.repeat(200) + '\n', 1000)
  expect(statSync(file).size).toBeLessThanOrEqual(1000)
  expect(readFileSync(file, 'utf8').endsWith('y'.repeat(200) + '\n')).toBe(true)
})

// #156: the morning's reason for leaving the graphics card was gone from main.log by the afternoon
it('past its cap the whole file is kept as main.old.log, and only the one before that goes', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'yogurt-log-')), 'main.log')
  expect(oldLogFile(file)).toBe(file.replace(/main\.log$/, 'main.old.log'))
  writeFileSync(file, 'morning\n' + 'x'.repeat(990))
  writeLog(file, 'afternoon\n', 1000)
  expect(readFileSync(oldLogFile(file), 'utf8').startsWith('morning\n')).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe('afternoon\n')
  writeLog(file, 'z'.repeat(995) + '\n', 1000)
  expect(readFileSync(oldLogFile(file), 'utf8')).toBe('afternoon\n')
  expect(existsSync(file)).toBe(true)
})
