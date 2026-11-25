import { setTimeout as pause } from 'node:timers/promises'
import { t } from '../shared/i18n'
import { Refusal, type Args } from './mcp/args'
import { accessDenied, GranolaDenied, granolaResource, signInAgain } from './granolaOAuth'
import { granolaDocumentId, type GranolaItem } from './granola'

const unreadable = () => new Refusal(t("Couldn't read Granola's response."))
export class GranolaLimit extends Refusal {
  constructor(readonly retryAt = Date.now() + 3_600_000) { super(t('Granola reached its request limit. Try again in an hour or use CSV.')) }
}
class ExpiredSession extends Error {}
class PlanLimit extends Refusal {}
class NoTranscript extends Refusal {}
function failure(message: string): never {
  if (/rate.?limit|too many requests|quota|calls per hour|requests per hour/i.test(message)) throw new GranolaLimit()
  if (/paid|upgrade|basic plan|business plan/i.test(message)) throw new PlanLimit(t('On Basic, Connect imports the last 30 days without transcripts. Use CSV for your full history and transcripts.'))
  if (/permission|access|forbidden|disabled|admin/i.test(message)) throw accessDenied()
  if (/no transcript (?:is )?(?:available|found)|does not have a transcript|transcript (?:is )?not (?:available|found)/i.test(message)) throw new NoTranscript()
  throw unreadable()
}

type Obj = Record<string, unknown>
const object = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {}
const string = (v: unknown) => typeof v === 'string' ? v : undefined

/** Stop at our JSON-RPC response, even when the server leaves the event stream open. */
async function rpcResult(response: Response, id: number) {
  const check = (v: unknown) => {
    const msg = object(v)
    if (msg.id !== id) return
    if (msg.error) failure(string(object(msg.error).message) || '')
    if (msg.jsonrpc !== '2.0' || !msg.result) throw unreadable()
    return object(msg.result)
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const result = check(await response.json())
    if (!result) throw unreadable()
    return result
  }
  const reader = response.body?.getReader()
  if (!reader) throw unreadable()
  const decoder = new TextDecoder()
  let pending = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      pending += decoder.decode(value, { stream: !done })
      if (pending.length > 16_000_000) throw unreadable()
      const events = pending.split(/\r?\n\r?\n/)
      pending = done ? '' : events.pop()!
      for (const event of events) {
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data) continue
        const result = check(JSON.parse(data))
        if (result) return result
      }
      if (done) throw unreadable()
    }
  } finally { await reader.cancel().catch(() => {}) }
}

type Tool = { name: string; inputSchema: { properties?: Record<string, { type?: string; enum?: string[]; maxItems?: number }>; required?: string[] } }

const field = (s: string, tag: string) => s.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i'))?.[1]?.trim()
const unescapeXml = (s: string) => s.replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) => ({ lt:'<', gt:'>', quot:'"', apos:"'", amp:'&' })[name]!)
function unpack(result: Obj): unknown {
  const content = Array.isArray(result.content) ? result.content : []
  const text = content.map(c => string(object(c).text) || '').join('\n').trim()
  if (result.isError) failure(text)
  if (result.structuredContent != null) return result.structuredContent
  if (/^[\[{]/.test(text)) { try { return JSON.parse(text) } catch { /* plain transcripts can begin with a timestamp */ } }
  return text
}

function meetings(value: unknown): Obj[] {
  if (typeof value !== 'string') {
    const o = object(value)
    const list = Array.isArray(value) ? value : o.meetings ?? o.results ?? o.notes ?? o.items
    if (!Array.isArray(list)) throw unreadable()
    return list.map(object)
  }
  const rows: Obj[] = []
  for (const match of value.matchAll(/<meeting\b([^>]*?)>([\s\S]*?)<\/meeting>/gi)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1], unescapeXml(m[2] ?? m[3])]))
    const body = match[2]
    rows.push({ ...attrs, summary: field(body, 'summary') ?? field(body, 'enhanced_notes'), private_notes: field(body, 'private_notes'),
      attendees: (field(body, 'known_participants') ?? '').split('\n').map(line => line.trim()).filter(Boolean).map(line => {
        const person = line.match(/^(.*?)(?:\s+\(note creator\))?(?:\s+from\s+.*?)?\s*<([^<>\s]+@[^<>\s]+)>$/)
        return { name: person?.[1]?.trim() || line, email: person?.[2] }
      }) })
  }
  if (!rows.length && !/<meetings_data\b[^>]*\bcount=["']0["']|^no meetings\b/i.test(value)) throw unreadable()
  return rows
}
const idOf = (row: Obj) => {
  const id = string(row.document_id ?? row.meeting_id ?? row.id)
  if (!id || !/^[a-zA-Z0-9_-]{1,150}$/.test(id)) throw unreadable()
  return granolaDocumentId(id)
}
function transcript(value: unknown, id: string): Args {
  if (typeof value === 'string') {
    if (!value.startsWith('<transcript')) return { transcript: value }
    const returnedId = value.match(/\bmeeting_id=["']([^"']+)["']/)?.[1]
    if (returnedId && granolaDocumentId(returnedId) !== id) throw unreadable()
    const text = field(value, 'transcript')
    if (text === undefined) throw unreadable()
    return { transcript: unescapeXml(text) }
  }
  const o = object(value)
  if (o.meeting_id && granolaDocumentId(String(o.meeting_id)) !== id) throw unreadable()
  const lines = Array.isArray(value) ? value : o.transcript ?? o.chunks ?? o.text
  if (typeof lines === 'string') return { transcript: lines }
  if (!Array.isArray(lines)) throw unreadable()
  return { transcript_lines: lines.map(line => { const l = object(line); return { text: l.text, speaker: string(l.speaker) ?? string(object(l.speaker).name), start_ms: l.start_ms, end_ms: l.end_ms } }) }
}

export async function granolaMcpItems(o: { token(refresh: boolean): Promise<string>; hasDocument(id: string): boolean; notesOnly(basic: boolean): void; rateLimited?(until: number): Promise<void> }, request = fetch, wait: (ms: number) => Promise<unknown> = pause): Promise<GranolaItem[]> {
  let seq = 0, session = '', version = '', last = 0
  const sendOnce = async (method: string, params?: Obj, notification = false): Promise<Obj> => {
    const id = ++seq
    const payload = JSON.stringify({ jsonrpc:'2.0', ...(notification ? {} : { id }), method, params })
    const post = async (refresh: boolean) => {
      const token = await o.token(refresh)
      return request(granolaResource, { method:'POST', redirect:'error', signal: AbortSignal.timeout(45_000), body:payload,
        headers: { Authorization:'Bearer ' + token, Accept:'application/json, text/event-stream', 'Content-Type':'application/json',
          ...(session && { 'Mcp-Session-Id':session }), ...(version && { 'MCP-Protocol-Version':version }) } })
    }
    let r = await post(false)
    if (r.status === 401) r = await post(true)
    if (r.status === 401) throw signInAgain()
    if (r.status === 404 && session && method !== 'initialize') throw new ExpiredSession()
    if (r.status === 403) throw accessDenied()
    if (r.status === 429) {
      const retry = r.headers.get('Retry-After')
      const until = retry && (/^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry))
      throw new GranolaLimit(typeof until === 'number' && Number.isFinite(until) ? Math.max(Date.now() + 1000, until) : undefined)
    }
    if (!r.ok) throw unreadable()
    if (method === 'initialize') session = r.headers.get('Mcp-Session-Id') || ''
    const result = notification ? {} : await rpcResult(r, id)
    if (result.isError) unpack(result)
    return result
  }
  const send = async (...args: Parameters<typeof sendOnce>): Promise<Obj> => {
    let reopened = false
    for (;;) {
      try { return await sendOnce(...args) }
      catch (e) {
        if (e instanceof ExpiredSession && !reopened && args[0] !== 'notifications/initialized') {
          reopened = true
          await initialize()
          continue
        }
        if (!(e instanceof GranolaLimit) || !o.rateLimited) throw e
        await o.rateLimited(e.retryAt)
      }
    }
  }
  const initialize = async () => {
    session = version = ''
    const init = await send('initialize', { protocolVersion:'2025-11-25', capabilities:{}, clientInfo:{ name:'Yogurt', version:'1' } })
    version = String(init.protocolVersion)
    if (!['2025-11-25','2025-06-18','2025-03-26'].includes(version)) throw unreadable()
    await send('notifications/initialized', undefined, true)
  }
  await initialize()
  const tools = new Map<string, Tool>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  do {
    const result = await send('tools/list', cursor ? { cursor } : {})
    if (!Array.isArray(result.tools)) throw unreadable()
    for (const tool of result.tools) if (typeof tool?.name === 'string' && tool.inputSchema?.type === 'object') tools.set(tool.name, tool)
    cursor = string(result.nextCursor)
    if (cursor && cursors.has(cursor)) throw unreadable()
    if (cursor) cursors.add(cursor)
  } while (cursor)
  const list = tools.get('list_meetings') ?? tools.get('search_meetings'), get = tools.get('get_meetings')
  let words = tools.get('get_meeting_transcript')
  if (!list || !get) throw accessDenied()
  const property = (tool: Tool, names: string[], type: string) => {
    const key = names.find(n => tool.inputSchema.properties?.[n]?.type === type)
    if (!key) throw unreadable()
    return key
  }
  const idsKey = property(get, ['meeting_ids','ids','document_ids'], 'array')
  const wordKey = words && property(words, ['meeting_id','document_id','id'], 'string')
  const call = async (tool: Tool, args: Obj) => {
    if (tool.inputSchema.required?.some(k => !(k in args))) throw unreadable()
    await wait(Math.max(0, last + 510 - Date.now()))
    last = Date.now()
    return unpack(await send('tools/call', { name:tool.name, arguments:args }))
  }
  if (!words) o.notesOnly(false)
  const args: Obj = {}
  const props = list.inputSchema.properties ?? {}
  if (props.time_range?.enum?.includes('all_time')) args.time_range = 'all_time'
  else if (props.time_range?.enum?.includes('custom') && props.custom_start && props.custom_end) {
    Object.assign(args, { time_range:'custom', custom_start:'1970-01-01T00:00:00Z', custom_end:new Date().toISOString() })
  }
  const listed = new Map<string, Obj>()
  cursors.clear()
  do {
    let result: unknown
    try { result = await call(list, args) }
    catch (e) {
      if (!(e instanceof PlanLimit) || args.time_range === 'last_30_days' || !props.time_range?.enum?.includes('last_30_days')) throw e
      delete args.custom_start
      delete args.custom_end
      args.time_range = 'last_30_days'
      words = undefined
      o.notesOnly(true)
      result = await call(list, args)
    }
    for (const row of meetings(result)) listed.set(idOf(row), row)
    cursor = typeof result === 'string' ? result.match(/\bnext_cursor=["']([^"']+)["']/)?.[1] : string(object(result).next_cursor ?? object(result).nextCursor)
    if (!cursor && (object(result).has_more === true || object(result).hasMore === true)) throw unreadable()
    if (cursor) {
      if (!props.cursor || cursors.has(cursor)) throw unreadable()
      args.cursor = cursor; cursors.add(cursor)
    }
  } while (cursor)
  const items: GranolaItem[] = []
  const missing: [string, Obj][] = []
  for (const [id, row] of listed) {
    if (o.hasDocument(id)) items.push({ title:string(row.title) || id, duplicate:true, read:() => ({ source_id:'granola:' + id }) })
    else missing.push([id, row])
  }
  const size = Math.max(1, Math.min(10, get.inputSchema.properties?.[idsKey]?.maxItems ?? 10))
  for (let i = 0; i < missing.length; i += size) {
    const batch = missing.slice(i, i + size)
    let details: Promise<Map<string, Obj>> | undefined
    for (const [id, summary] of batch) items.push({ title:string(summary.title) || id, read: async () => {
      details ??= call(get, { [idsKey]:batch.map(([key]) => key) }).then(value => new Map(meetings(value).map(row => [idOf(row), row])))
      const row = (await details).get(id)
      if (!row) throw unreadable()
      let text: Args = {}
      if (words && wordKey) {
        try { text = transcript(await call(words, { [wordKey]:id }), id) }
        catch (e) {
          if (e instanceof PlanLimit || e instanceof GranolaDenied) { words = undefined; o.notesOnly(e instanceof PlanLimit) }
          else if (!(e instanceof NoTranscript)) throw e
        }
      }
      const attendees = row.attendees ?? summary.attendees
      return { source_id:'granola:' + id, title:row.title || summary.title || t('Untitled meeting'), started_at:row.date ?? row.started_at ?? row.created_at ?? summary.date ?? summary.started_at ?? summary.created_at,
        summary:row.summary_markdown ?? row.summary ?? row.enhanced_notes, my_notes:row.private_notes_markdown ?? row.private_notes ?? row.notes,
        attendees:Array.isArray(attendees) ? attendees.map(a => typeof a === 'string' ? { name:a } : { name:a.name || a.email, email:a.email }) : undefined, ...text }
    } })
  }
  return items
}
