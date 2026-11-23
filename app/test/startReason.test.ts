import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AI_APP_ARG, startArgs, startReason } from '../src/main/startReason'

const env = {}

describe('why Yogurt started (#147)', () => {
  it('is an AI app when its yogurt-mcp says so', () => {
    expect(startReason({ argv: ['Yogurt.exe', '--hidden', AI_APP_ARG], env })).toBe('ai-app')
    expect(startReason({ argv: ['Yogurt'], env: { YOGURT_STARTED_BY: 'ai-app' } })).toBe('ai-app')
  })
  it('is an AI app when an older yogurt-mcp started it with only --hidden (Linux can see the parent)', () => {
    expect(startReason({ argv: ['yogurt', '--hidden'], env, parent: 'yogurt-mcp' })).toBe('ai-app')
    expect(startReason({ argv: ['Yogurt.exe', '--hidden'], env, parent: 'yogurt-mcp.exe' })).toBe('ai-app')
  })
  it('is login for the login item (--hidden on Windows and Linux, the Mac says so itself)', () => {
    expect(startReason({ argv: ['Yogurt.exe', '--hidden'], env })).toBe('login')
    expect(startReason({ argv: ['Yogurt'], env, openedAtLogin: true })).toBe('login')
    expect(startReason({ argv: ['yogurt', '--hidden'], env, parent: 'systemd' })).toBe('login')
  })
  it('is an update when the installer opens it again', () => {
    expect(startReason({ argv: ['Yogurt.exe', '--updated'], env })).toBe('update')
  })
  it('is the person otherwise (a shortcut, the Start menu, a notification clicked after quitting)', () => {
    expect(startReason({ argv: ['Yogurt.exe'], env })).toBe('user')
    expect(startReason({ argv: ['Yogurt.exe', '--allow-file-access-from-files'], env })).toBe('user')
  })
  it('logs the switches it was given, never a path', () => {
    expect(startArgs(['C:\\Users\\sam\\AppData\\Local\\Programs\\yogurt\\Yogurt.exe', '--hidden', AI_APP_ARG, 'C:\\Users\\sam\\file.txt', '--x=/home/sam/a'])).toBe(`--hidden ${AI_APP_ARG} --x`)
    expect(startArgs(['Yogurt'])).toBe('none')
  })
  it('is what both yogurt-mcp helpers pass when they start Yogurt', () => {
    for (const f of ['native/yogurt-mcp-relay/src/main.rs', 'native/yogurt-mcp/main.swift']) expect(readFileSync(join(__dirname, '..', f), 'utf8')).toContain(`"${AI_APP_ARG}"`)
  })
})
