import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectGranola, refreshGranola } from '../src/main/granolaOAuth'
import { granolaMcpItems, GranolaLimit } from '../src/main/granolaMcp'
import { safeStorage } from 'electron'
import { hookGranola } from '../src/main/granolaIpc'
import type { GranolaStatus } from '../src/shared/granola'
import { Refusal } from '../src/main/mcp/args'

const handlers = new Map<string, (event: unknown, arg?: unknown) => unknown>()
vi.mock('electron', () => ({
  shell: { openExternal:vi.fn() },
  ipcMain: { handle: (name: string, fn: (e: unknown, a: unknown) => unknown) => handlers.set(name, fn) },
  safeStorage: { isEncryptionAvailable: vi.fn(() => true), getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: vi.fn(() => Buffer.from('sealed test value')), decryptString: vi.fn(() => 'fictional-key') },
}))
vi.mock('../src/main/granolaOAuth', async original => ({
  ...await original<typeof import('../src/main/granolaOAuth')>(), connectGranola:vi.fn(), refreshGranola:vi.fn(),
}))
vi.mock('../src/main/granolaMcp', async original => ({
  ...await original<typeof import('../src/main/granolaMcp')>(), granolaMcpItems:vi.fn(),
}))
const sender = { mainFrame: {}, send: vi.fn() }
const event = { sender, senderFrame: sender.mainFrame }
const call = (name: string, arg?: unknown) => handlers.get('granola:' + name)!(event, arg)
const status = () => call('status') as GranolaStatus
let dir: string, file: string
const recording = vi.fn(() => false), previouslyImported = vi.fn(() => false)
const ids = new Set<string>()
const start = () => hookGranola({ settingsFile: file, window: () => ({ webContents: sender }) as never,
  usedGranola: process.env.YOGURT_FAKE_GRANOLA === '1', sourceIds: () => [...ids],
  recording, previouslyImported, save(args) {
    if (!args.summary) throw new Refusal('Missing summary')
    const id = String(args.source_id), already_imported = ids.has(id)
    ids.add(id)
    return { id, already_imported }
  },
})
beforeEach(() => {
  vi.clearAllMocks()
  recording.mockReturnValue(false); previouslyImported.mockReturnValue(false); ids.clear()
  vi.stubEnv('YOGURT_FAKE_GRANOLA', '1')
  dir = mkdtempSync(join(tmpdir(), 'yogurt-granola-test-')); file = join(dir, 'settings.json')
  start()
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) })

it('offers only a detected, unimported source outside recording, and remembers dismissal across restarts', () => {
  expect(call('offer')).toBe(true)
  recording.mockReturnValue(true); expect(call('offer')).toBe(false)
  recording.mockReturnValue(false); previouslyImported.mockReturnValue(true); expect(call('offer')).toBe(false)
  previouslyImported.mockReturnValue(false); call('dismiss'); start(); expect(call('offer')).toBe(false)
  vi.stubEnv('YOGURT_FAKE_GRANOLA', '0'); file = join(dir, 'another.json'); start()
  expect(call('offer')).toBe(false)
  expect(status().phase).toBe('idle')
})

it('reports partial success, the reason per failure and duplicates on retry', async () => {
  const csv = 'document_id,document_title,summary\na,First,One\nb,Second,\nc,Third,Three'
  await call('csv', csv)
  expect(status().result).toEqual({ added: 2, skipped: 0, total: 3, failures: [{ title: 'Second', reason: 'Missing summary' }] })
  expect(call('offer')).toBe(false)
  await call('csv', csv)
  expect(status().result).toMatchObject({ added: 0, skipped: 2 })
})

it('protects the key, rejects other frames, restores the saved key and removes it', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ notes: [], hasMore: false, cursor: null })))
  expect(handlers.get('granola:list')!({ sender, senderFrame: {} }, 'fictional-key')).toBeUndefined()
  expect(fetch).not.toHaveBeenCalled()
  await call('list', 'fictional-key')
  expect(status()).toMatchObject({ hasKey: true, available: 0 })
  expect(readFileSync(file, 'utf8')).not.toContain('fictional-key')
  expect(JSON.stringify(status())).not.toContain('sealed')
  start(); await call('list'); expect(safeStorage.decryptString).toHaveBeenCalled()
  call('remove'); start(); expect(status().hasKey).toBe(false)
  expect(readFileSync(file, 'utf8')).not.toContain('granolaKey')
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValueOnce(false)
  await call('list', 'fictional-key')
  expect(status()).toMatchObject({ hasKey: false, available: null, error: expect.stringContaining('secure storage') })
})

it('keeps tokens in secure storage, refreshes before import, preserves partial progress and disconnects across restarts', async () => {
  const expired = { clientId:'test-client', access:'fictional-access', refresh:'fictional-refresh', expires:0 }
  vi.mocked(connectGranola).mockResolvedValueOnce(expired)
  await call('connect')
  expect(status().connected).toBe(true)
  expect(safeStorage.encryptString).toHaveBeenCalledWith(JSON.stringify(expired))
  expect(readFileSync(file, 'utf8')).not.toContain('fictional-')
  expect(JSON.stringify(status())).not.toContain('fictional-')
  start()
  vi.mocked(safeStorage.decryptString).mockReturnValueOnce(JSON.stringify(expired))
  vi.mocked(refreshGranola).mockResolvedValueOnce({...expired, access:'rotated-access', refresh:'rotated-refresh', expires:Date.now()+3_600_000})
  vi.mocked(granolaMcpItems).mockImplementationOnce(async options => {
    expect(await options.token(false)).toBe('rotated-access')
    expect(options.hasDocument('sample')).toBe(false)
    return [{title:'One',read:() => ({source_id:'granola:sample',summary:'One'})}, {title:'Two',read:() => { throw new GranolaLimit() }}]
  })
  await call('import-connected')
  expect(status()).toMatchObject({phase:'idle',connected:true,error:expect.stringContaining('hour'),result:{added:1,total:2}})
  expect(readFileSync(file, 'utf8')).not.toContain('rotated')
  call('disconnect')
  start()
  expect(status().connected).toBe(false)
  expect(readFileSync(file, 'utf8')).not.toContain('granolaConnection')
})

it('cancels browser sign-in without storing a late response or displaying an error', async () => {
  vi.mocked(connectGranola).mockImplementationOnce(async (_open, signal) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once:true}))
    return {clientId:'fictional',access:'late'}
  })
  const pending = call('connect')
  expect(status().phase).toBe('connecting')
  call('cancel-connect')
  await pending
  expect(safeStorage.encryptString).not.toHaveBeenCalled()
  expect(status()).toMatchObject({connected:false,phase:'idle',cancelled:true,error:null})
})

it('matches a legacy compact document ID when importing the canonical UUID from CSV', async () => {
  ids.add('granola:AABBCCDD000000000000000000000012')
  await call('csv', 'document_id,summary\naabbccdd-0000-0000-0000-000000000012,Sample')
  expect(status().result).toMatchObject({added:0,skipped:1})
  expect(ids.size).toBe(1)
})

it('continues from browser sign-in through discovery, an hourly limit and the saved rows after leaving onboarding', async () => {
  const connection = { clientId:'test-client', access:'fiction' }
  vi.mocked(connectGranola).mockResolvedValueOnce(connection)
  vi.mocked(safeStorage.decryptString).mockReturnValueOnce(JSON.stringify(connection))
  let signalWaiting!: () => void
  const waiting = new Promise<void>(resolve => { signalWaiting = resolve })
  vi.mocked(granolaMcpItems).mockImplementationOnce(async options => {
    expect(status().phase).toBe('finding')
    options.notesOnly(true)
    return ['First','Second'].map((title, i) => ({ title, read: async () => {
      if (i) {
        const pause = options.rateLimited!(Date.now() + 50)
        signalWaiting()
        await pause
      }
      return { source_id:'granola:' + i, title, summary:'Example' }
    } }))
  })
  const done = call('connect', true)
  await waiting
  expect(status()).toMatchObject({phase:'waiting', retryAt:expect.any(Number), result:{added:1,total:2},recent:[{title:'First'}]})
  call('dismiss')
  await done
  expect(status()).toMatchObject({phase:'idle',retryAt:null,notice:expect.stringContaining('30 days'),result:{added:2},recent:[{title:'Second'},{title:'First'}]})
  expect(readFileSync(file,'utf8')).not.toContain('granolaResumeAt')
})

it('restores a scheduled import on launch and lets Settings disconnect before the retry', async () => {
  const { updateSettings } = await import('../src/main/settings')
  updateSettings(file, {granolaConnection:'sealed', granolaResumeAt:Date.now() + 60_000})
  start()
  expect(status().phase).toBe('waiting')
  call('disconnect')
  await vi.waitFor(() => expect(status()).toMatchObject({phase:'idle',connected:false,error:null,retryAt:null}))
  expect(granolaMcpItems).not.toHaveBeenCalled()
  expect(readFileSync(file,'utf8')).not.toContain('granolaResumeAt')
})

it('stops reading the current batch when disconnected during a quota wait', async () => {
  const connection = {clientId:'fiction',access:'fiction'}
  vi.mocked(connectGranola).mockResolvedValueOnce(connection)
  vi.mocked(safeStorage.decryptString).mockReturnValueOnce(JSON.stringify(connection))
  const later = vi.fn()
  vi.mocked(granolaMcpItems).mockImplementationOnce(async options => [
    {title:'First',read:async () => { await options.rateLimited!(Date.now()+60_000); return {summary:'First',source_id:'granola:first'} }},
    {title:'Second',read:later},
  ])
  const done = call('connect',true)
  await vi.waitFor(() => expect(status().phase).toBe('waiting'))
  call('disconnect')
  await done
  expect(later).not.toHaveBeenCalled()
  expect(status()).toMatchObject({phase:'idle',connected:false,error:null,result:{added:0,failures:[]}})
})

it('resumes an interrupted import on launch using the meetings that were already saved', async () => {
  const { updateSettings } = await import('../src/main/settings')
  updateSettings(file, {granolaConnection:'sealed',granolaResumeAt:0})
  ids.add('granola:previous')
  vi.mocked(safeStorage.decryptString).mockReturnValueOnce(JSON.stringify({clientId:'test-client',access:'test-access'}))
  vi.mocked(granolaMcpItems).mockImplementationOnce(async options => [
    {title:'Previous',duplicate:options.hasDocument('previous'),read:() => {throw Error('Already saved')}},
    {title:'Remaining',read:() => ({source_id:'granola:next',summary:'Remaining'})},
  ])
  start()
  await vi.waitFor(() => expect(status()).toMatchObject({phase:'idle',recent:[{title:'Remaining'}],result:{added:1,skipped:1,total:2},error:null}))
  expect(readFileSync(file,'utf8')).not.toContain('granolaResumeAt')
})
