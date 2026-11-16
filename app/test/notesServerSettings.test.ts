import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { activeServer, checkServer, cleanUrl } from '../src/main/notes/remote'
import { notesServerSettings } from '../src/main/notes/serverSettings'
import { checkText } from '../src/renderer/src/components/NotesServerSettings'

const profile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-server-'))
  return { dir, settingsFile: join(dir, 'settings.json') }
}
const settings = (file: string) => JSON.parse(readFileSync(file, 'utf8'))

describe('activeServer', () => {
  it('is the server when it is on with an address and a model', () => {
    expect(activeServer({ url: 'http://a/v1', model: 'm' })).toBeTruthy()
    expect(activeServer({ url: 'http://a/v1', model: 'm', enabled: true })).toBeTruthy()
  })
  it('is none when off, or missing the address or model', () => {
    expect(activeServer(undefined)).toBeUndefined()
    expect(activeServer({ url: 'http://a/v1', model: 'm', enabled: false })).toBeUndefined()
    expect(activeServer({ url: ' ', model: 'm' })).toBeUndefined()
    expect(activeServer({ url: 'http://a/v1', model: '' })).toBeUndefined()
  })
})

describe('cleanUrl', () => {
  it('keeps http and https addresses, without a trailing slash', () => {
    expect(cleanUrl(' http://10.0.0.2:4000/v1/ ')).toBe('http://10.0.0.2:4000/v1')
    expect(cleanUrl('https://notes.example/v1')).toBe('https://notes.example/v1')
  })
  it('refuses anything else', () => {
    expect(cleanUrl('file:///etc/passwd')).toBeUndefined()
    expect(cleanUrl('localhost:4000')).toBeUndefined()
    expect(cleanUrl('not a url')).toBeUndefined()
  })
})

describe('checkServer', () => {
  const reply = (r: Response) => vi.fn(async () => r) as unknown as typeof fetch
  it('lists the models the server offers', async () => {
    const f = reply(new Response(JSON.stringify({ data: [{ id: 'qwen' }, { id: 'gemma' }, { nope: 1 }] })))
    expect(await checkServer('http://a/v1/', 'k', 1000, f)).toEqual({ ok: true, models: ['qwen', 'gemma'] })
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['http://a/v1/models', expect.objectContaining({ headers: { Authorization: 'Bearer k' } })])
  })
  it('says why it could not', async () => {
    expect(await checkServer('ftp://a', undefined)).toEqual({ ok: false, reason: 'address' })
    expect(await checkServer('http://a/v1', 'bad', 1000, reply(new Response('', { status: 401 })))).toEqual({ ok: false, reason: 'refused', status: 401 })
    expect(await checkServer('http://a/v1', undefined, 1000, reply(new Response('', { status: 500 })))).toEqual({ ok: false, reason: 'status', status: 500 })
    const down = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    expect(await checkServer('http://a/v1', undefined, 1000, down)).toEqual({ ok: false, reason: 'unreachable' })
  })
  it('says it in words', () => {
    expect(checkText({ ok: true, models: ['a', 'b'] })).toMatch(/Connected/)
    expect(checkText({ ok: false, reason: 'refused', status: 401 })).toContain('401')
    expect(checkText({ ok: false, reason: 'unreachable' })).toMatch(/reach/)
  })
})

describe('notesServerSettings', () => {
  it('is off with nothing saved', () => {
    const p = profile()
    expect(notesServerSettings({ settingsFile: p.settingsFile, profile: p.dir }).view()).toEqual({ enabled: false, url: '', model: '', hasKey: false })
  })

  it('saves the address, model and switch in settings, and the key in its own file only this user can read', () => {
    const p = profile()
    writeFileSync(p.settingsFile, JSON.stringify({ myName: 'Sam' }))
    const s = notesServerSettings({ settingsFile: p.settingsFile, profile: p.dir })
    const v = s.set({ url: 'http://10.0.0.2:4000/v1/', model: 'qwen', enabled: true, key: ' sk-secret ' })
    expect(v).toEqual({ enabled: true, url: 'http://10.0.0.2:4000/v1', model: 'qwen', hasKey: true })
    const keyFile = join(p.dir, 'notes-server.key')
    expect(readFileSync(keyFile, 'utf8')).toBe('sk-secret\n')
    expect(statSync(keyFile).mode & 0o777).toBe(0o600)
    const saved = settings(p.settingsFile)
    expect(saved.myName).toBe('Sam')
    expect(saved.notesServer).toEqual({ url: 'http://10.0.0.2:4000/v1', model: 'qwen', enabled: true, keyFile })
    expect(JSON.stringify(saved)).not.toContain('sk-secret')
    expect(JSON.stringify(v)).not.toContain('sk-secret')
  })

  it('turns off without forgetting the address, and removes the key on request', () => {
    const p = profile()
    const s = notesServerSettings({ settingsFile: p.settingsFile, profile: p.dir })
    s.set({ url: 'http://a/v1', model: 'm', enabled: true, key: 'k' })
    expect(s.set({ enabled: false })).toEqual({ enabled: false, url: 'http://a/v1', model: 'm', hasKey: true })
    expect(s.set({ key: '' }).hasKey).toBe(false)
    expect(existsSync(join(p.dir, 'notes-server.key'))).toBe(false)
    expect(settings(p.settingsFile).notesServer.keyFile).toBeUndefined()
  })

  it('refuses an address that is not http or https, and saves nothing', () => {
    const p = profile()
    const s = notesServerSettings({ settingsFile: p.settingsFile, profile: p.dir })
    expect(() => s.set({ url: 'file:///etc/passwd', model: 'm', enabled: true })).toThrow()
    expect(existsSync(p.settingsFile)).toBe(false)
  })

  it('tests with the key being typed, or the saved one', async () => {
    const p = profile()
    const check = vi.fn(async () => ({ ok: true as const, models: [] }))
    const s = notesServerSettings({ settingsFile: p.settingsFile, profile: p.dir, check })
    s.set({ url: 'http://a/v1', model: 'm', key: 'saved' })
    await s.check('http://a/v1', 'typed')
    await s.check('http://a/v1')
    expect(check.mock.calls).toEqual([['http://a/v1', 'typed'], ['http://a/v1', 'saved']])
  })

  it('reads a key file set by hand in settings.json', () => {
    const p = profile()
    const keyFile = join(p.dir, 'elsewhere.key')
    writeFileSync(keyFile, 'hand\n')
    writeFileSync(p.settingsFile, JSON.stringify({ notesServer: { url: 'http://a/v1', model: 'm', keyFile } }))
    expect(notesServerSettings({ settingsFile: p.settingsFile, profile: p.dir }).view()).toEqual({ enabled: true, url: 'http://a/v1', model: 'm', hasKey: true })
  })
})
