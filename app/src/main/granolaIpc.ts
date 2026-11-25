import { ipcMain, safeStorage, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { setImmediate as yieldToWindow, setTimeout as delay } from 'node:timers/promises'
import { GRANOLA_CSV_BYTES, type GranolaStatus, type GranolaMethod } from '../shared/granola'
import { t } from '../shared/i18n'
import { granolaApi, granolaCsv, granolaDocumentId, type GranolaItem } from './granola'
import { Refusal, type Args } from './mcp/args'
import { connectGranola, refreshGranola, GranolaReconnect, GranolaDenied, signInAgain, type GranolaConnection } from './granolaOAuth'
import { GranolaLimit, granolaMcpItems } from './granolaMcp'
import { loadSettings, updateSettings } from './settings'

export function hookGranola(d: {
  settingsFile: string; window(): BrowserWindow | undefined; save(a: Args, fillMissingTranscript?: boolean): { already_imported?: boolean; id: string; title?: string }
  usedGranola: boolean; sourceIds(): string[]
  previouslyImported(): boolean; recording(): boolean
}) {
  let cooldown: AbortController | undefined
  let connecting: AbortController | undefined
  const settings = () => loadSettings(d.settingsFile)
  const state: GranolaStatus = { source: null, connected: !!settings().granolaConnection, notice: null, hasKey: !!settings().granolaKey, phase: 'idle', recent: [], cancelled: false, retryAt: null, available: null, result: null, error: null }
  let preview: { id: string; title: string }[] | null = null
  const changed = () => d.window()?.webContents.send('granola:changed')
  const handle = (channel: string, action: (arg: unknown) => unknown) => {
    ipcMain.handle('granola:' + channel, (e: IpcMainInvokeEvent, arg: unknown) => {
      const web = d.window()?.webContents
      if (!web || e.sender !== web || e.senderFrame !== web.mainFrame) return
      return action(arg)
    })
  }
  const hide = () => updateSettings(d.settingsFile, { granolaPromptHidden: true })
  handle('offer', () => d.usedGranola && !d.recording() && !settings().granolaPromptHidden && !d.previouslyImported())
  handle('dismiss', () => { hide(); changed() })
  handle('status', () => state)

  const keyFailure = () => new Refusal(t("Yogurt couldn't open secure storage."))
  const secure = () => {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw keyFailure()
  }
  const seal = (value: string) => {
    secure()
    try { return safeStorage.encryptString(value).toString('base64') } catch { throw keyFailure() }
  }
  const unseal = (value: string) => {
    secure()
    try { return safeStorage.decryptString(Buffer.from(value, 'base64')) } catch { throw keyFailure() }
  }
  const savedKey = () => {
    const sealed = settings().granolaKey
    if (!sealed) throw new Refusal(t('Check your Granola API key and its access.'))
    return unseal(sealed)
  }
  const forgetConnection = () => {
    updateSettings(d.settingsFile, { granolaConnection: undefined, granolaResumeAt: undefined })
    state.connected = false
  }
  const disconnected = (e: unknown) => !state.connected && e instanceof Error && e.name === 'AbortError'
  const job = async (source: GranolaMethod, phase: Exclude<GranolaStatus['phase'], 'idle'>, run: () => Promise<void>) => {
    if (state.phase !== 'idle') return
    state.source = source
    state.phase = phase
    state.cancelled = false
    state.recent = []
    state.retryAt = null
    state.notice = null
    state.error = null
    state.result = null
    changed()
    try { await run() }
    catch (e) {
      if (e instanceof GranolaReconnect) forgetConnection()
      if (disconnected(e)) return
      state.error = e instanceof Refusal ? e.message : t("Yogurt couldn't make that change. Try again.")
    }
    finally { state.phase = 'idle'; changed() }
  }
  handle('list', input => job('key', 'listing', async () => {
    preview = null
    state.available = null
    if (input !== undefined && (typeof input !== 'string' || !/^[!-~]{1,1024}$/.test(input))) throw new Refusal(t('Check your Granola API key and its access.'))
    const key = typeof input === 'string' ? input : savedKey()
    const items = await granolaApi(key).list()
    if (typeof input === 'string') {
      updateSettings(d.settingsFile, { granolaKey: seal(key) })
      state.hasKey = true
    }
    preview = items
    state.available = items.length
  }))
  handle('remove', () => {
    if (state.phase !== 'idle') return
    updateSettings(d.settingsFile, { granolaKey: undefined })
    preview = null
    Object.assign(state, { hasKey: false, available: null, error: null })
    changed()
  })

  // An older import may have saved the same UUID in uppercase or without hyphens.
  const savedDocuments = () => new Map(d.sourceIds().map(source => [granolaDocumentId(source.slice('granola:'.length)), source]))
  const importItems = async (items: GranolaItem[], known = savedDocuments(), fillMissingTranscript = false) => {
    const result: NonNullable<GranolaStatus['result']> = { total: items.length, added: 0, skipped: 0, failures: [] }
    state.phase = 'importing'
    state.result = result
    changed()
    let lastUpdate = Date.now()
    for (const item of items) {
      try {
        if (item.duplicate) result.skipped++
        else {
          const args = await item.read()
          const id = String(args.source_id).slice('granola:'.length)
          args.source_id = known.get(id) ?? args.source_id
          const saved = d.save(args, fillMissingTranscript)
          if (saved.already_imported) result.skipped++
          else {
            result.added++
            state.recent = [{ id: saved.id, title: saved.title || item.title }, ...state.recent].slice(0, 3)
          }
        }
      } catch (e) {
        if (disconnected(e) || e instanceof GranolaLimit || e instanceof GranolaReconnect || e instanceof GranolaDenied) throw e
        result.failures.push({ title: item.title, reason: e instanceof Refusal ? e.message : t("Yogurt couldn't make that change. Try again.") })
      }
      if (Date.now() - lastUpdate >= 100) { changed(); lastUpdate = Date.now() }
      await yieldToWindow()
    }
    if (result.added || result.skipped) hide()
  }
  handle('connect', importAfterSignIn => job('connect', 'connecting', async () => {
    secure()
    const attempt = new AbortController()
    connecting = attempt
    const signal = AbortSignal.any([attempt.signal, AbortSignal.timeout(300_000)])
    try {
      const connection = await connectGranola(url => shell.openExternal(url), signal)
      if (!signal.aborted) {
        updateSettings(d.settingsFile, { granolaConnection: seal(JSON.stringify(connection)) })
        state.connected = true
      }
    } catch (e) { if (!attempt.signal.aborted) throw signal.aborted ? signInAgain() : e }
    finally { connecting = undefined }
    if (attempt.signal.aborted) state.cancelled = true
    else if (state.connected && importAfterSignIn === true) await importConnected()
  }))
  handle('cancel-connect', () => connecting?.abort())
  handle('disconnect', () => {
    if (state.phase !== 'idle' && state.phase !== 'waiting') return
    forgetConnection()
    cooldown?.abort()
    state.error = state.notice = null
    changed()
  })
  const waitForQuota = async (until: number) => {
    const previous = state.phase
    state.retryAt = until
    state.phase = 'waiting'
    updateSettings(d.settingsFile, { granolaResumeAt: until })
    changed()
    cooldown = new AbortController()
    try {
      while (Date.now() < until) await delay(Math.min(until - Date.now(), 2_147_483_647), undefined, { signal: cooldown.signal, ref: false })
    } finally { cooldown = undefined }
    state.retryAt = null
    state.phase = previous
    changed()
  }
  const importConnected = async () => {
    state.phase = 'finding'
    changed()
    const resumeAt = settings().granolaResumeAt
    updateSettings(d.settingsFile, { granolaResumeAt: resumeAt ?? 0 })
    try {
      if (resumeAt && resumeAt > Date.now()) await waitForQuota(resumeAt)
      await readConnected()
    } finally {
      state.retryAt = null
      updateSettings(d.settingsFile, { granolaResumeAt: undefined })
    }
  }
  const readConnected = async () => {
    const sealed = settings().granolaConnection
    if (!sealed) throw signInAgain()
    let connection: GranolaConnection = JSON.parse(unseal(sealed))
    if (!connection?.clientId || !connection.access) throw signInAgain()
    const known = savedDocuments()
    const items = await granolaMcpItems({
      hasDocument: id => known.has(id),
      rateLimited: waitForQuota,
      notesOnly: basic => {
        state.notice = basic ? t('On Basic, Connect imports the last 30 days without transcripts. Use CSV for your full history and transcripts.') : t('Transcripts are unavailable for this connection.')
        changed()
      },
      token: async force => {
        if (force || (connection.expires !== undefined && connection.expires < Date.now() + 30_000)) {
          connection = await refreshGranola(connection)
          updateSettings(d.settingsFile, { granolaConnection: seal(JSON.stringify(connection)) })
        }
        return connection.access
      },
    })
    await importItems(items, known)
  }
  handle('import-connected', () => job('connect', 'finding', importConnected))
  if (state.connected && settings().granolaResumeAt != null) void job('connect', 'finding', importConnected)
  handle('api', () => job('key', 'importing', async () => {
    if (!preview) throw new Refusal(t('Check your Granola API key and its access.'))
    const api = granolaApi(savedKey())
    await importItems(preview.map(note => ({ title: note.title, read: () => api.read(note.id) })))
  }))
  handle('csv', input => job('csv', 'importing', async () => {
    if (typeof input !== 'string' || Buffer.byteLength(input) > GRANOLA_CSV_BYTES) throw new Refusal(t('Choose a CSV file under 128 MB.'))
    await importItems(granolaCsv(input), savedDocuments(), true)
  }))
}
