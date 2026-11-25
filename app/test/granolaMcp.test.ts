import { expect, it, vi } from 'vitest'
import { granolaMcpItems } from '../src/main/granolaMcp'
import { granolaCsv } from '../src/main/granola'
import { setup, json } from './mcpRig'

const ids = ['aabbccdd-0000-0000-0000-000000000000', ...Array.from({length:11}, (_,i) => 'note-' + i)]
const date = '2026-02-04T09:00:00Z'
const text = (text: string, isError = false) => ({ content:[{type:'text', text}], isError })
const tool = (name: string, properties: object, required = Object.keys(properties)) => ({name, inputSchema:{ type:'object', properties, required }})
function fixture(plan: 'paid' | 'basic' | 'limited' | 'admin' | 'transcript-limited') {
  const batches: string[][] = [], ranges: string[] = []
  const words = vi.fn((id: string) => (plan === 'basic' || plan === 'transcript-limited') ? text('Transcripts are only available on paid plans', true)
    : text('<transcript meeting_id="' + id + '">[00:01] Lee: Review the chart</transcript>'))
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    const {id, method, params} = JSON.parse(String(init?.body))
    const reply = (result: unknown) => Response.json({jsonrpc:'2.0', id, result}, {headers:{'Mcp-Session-Id':'test-session'}})
    if (method === 'initialize') return reply({protocolVersion:'2025-06-18'})
    expect(new Headers(init?.headers).get('Mcp-Session-Id')).toBe('test-session')
    if (method === 'notifications/initialized') return new Response(null, {status:202})
    if (plan === 'admin') return new Response(null, {status:403})
    if (method === 'tools/list') return params.cursor ? reply({tools:[tool('get_meeting_transcript',{id:{type:'string'}})]})
      : reply({nextCursor:'page2',tools:[tool('list_meetings',{cursor:{type:'string'},time_range:{type:'string',enum:['all_time','last_30_days']}}, []), tool('get_meetings',{document_ids:{type:'array',maxItems:10}})]})
    const args = params.arguments
    if (params.name === 'list_meetings') {
      ranges.push(args.time_range)
      if (plan === 'basic' && args.time_range !== 'last_30_days') return reply(text('Basic plan supports only the last 30 days', true))
      return reply({structuredContent:{meetings:(args.cursor ? ids.slice(5) : ids.slice(0,6)).map(id => ({id,date,title:id})), next_cursor:args.cursor ? null : 'next'}})
    }
    if (params.name === 'get_meetings') {
      batches.push(args.document_ids)
      if (plan === 'limited' && batches.length === 2) return new Response(null,{status:429})
      const xml = args.document_ids.map((id: string) => '<meeting id="' + id + '" date="' + date + '" title="Plan"><summary>Blue charts</summary></meeting>').join('')
      const rpc = JSON.stringify({jsonrpc:'2.0',id,result:text('<meetings_data>' + xml + '</meetings_data>')})
      return new Response('event: message\ndata: ' + rpc + '\n\n', {headers:{'content-type':'text/event-stream'}})
    }
    if (params.name === 'get_meeting_transcript') return reply(words(args.id))
    throw Error('Unknown tool')
  })
  const options = {token:vi.fn(async () => 'fiction'), hasDocument:(id: string) => id === ids.at(-1), notesOnly:vi.fn()}
  return {words,batches,options,ranges,request,items:() => granolaMcpItems(options,request,async()=>{})}
}

it('uses the advertised schemas, pages through tools and overlapping notes, then reads ten missing IDs per call', async () => {
  const f = fixture('paid'), items = await f.items()
  expect(items).toHaveLength(12)
  expect(items[0].duplicate).toBe(true)
  expect(f.batches).toHaveLength(0)
  const args = []
  for (const item of items.slice(1)) args.push(await item.read())
  expect(f.batches.map(b => b.length)).toEqual([10,1])
  expect(f.words).toHaveBeenCalledTimes(11)
  expect(args[0]).toMatchObject({source_id:'granola:' + ids[0], summary:'Blue charts', transcript:'[00:01] Lee: Review the chart'})
  const {mcp} = setup({changes:true})
  const first = await json(mcp, 'create_meeting', args[0])
  const csv = await granolaCsv('document_id,summary\n' + ids[0].toUpperCase().replaceAll('-','') + ',Blue charts')[0].read()
  expect(await json(mcp, 'create_meeting', csv)).toMatchObject({id:first.id,already_imported:true})
})

it('imports Basic summaries, uses the supported 30-day range, and avoids repeated transcript requests', async () => {
  const f = fixture('basic'), items = await f.items()
  expect(await items[1].read()).toMatchObject({summary:'Blue charts'})
  expect(await items[2].read()).not.toHaveProperty('transcript')
  expect(f.options.notesOnly).toHaveBeenCalledOnce()
  expect(f.ranges).toContain('last_30_days')
  expect(f.words).not.toHaveBeenCalled()
})

it('keeps earlier batches usable and explains quota and Enterprise access limits', async () => {
  const f = fixture('limited'), items = await f.items()
  expect(await items[1].read()).toMatchObject({summary:'Blue charts'})
  await expect(items.at(-1)!.read()).rejects.toThrow(/in an hour or use CSV/)
  await expect(fixture('admin').items()).rejects.toThrow(/workspace settings or use CSV/)
})

it('retries the limited batch in place without refetching the saved batch', async () => {
  const f = fixture('limited'), rateLimited = vi.fn(async (_until: number) => {})
  const items = await granolaMcpItems({ ...f.options, rateLimited }, f.request, async () => {})
  for (const item of items) await item.read()
  expect(rateLimited).toHaveBeenCalledOnce()
  expect(rateLimited.mock.calls[0][0]).toBeGreaterThan(Date.now() + 3_590_000)
  expect(f.batches.map(batch => batch.length)).toEqual([10, 1, 1])
  expect(f.batches[1]).toEqual(f.batches[2])
})

it('renews an expired MCP session after a quota wait and honors Retry-After', async () => {
  const f = fixture('paid')
  let attempts = 0
  const request: typeof fetch = async (url, init) => {
    if (JSON.parse(String(init?.body)).params?.name === 'get_meetings') {
      if (++attempts === 1) return new Response(null, {status:429,headers:{'Retry-After':'120'}})
      if (attempts === 2) return new Response(null, {status:404})
    }
    return f.request(url,init)
  }
  const before = Date.now(), rateLimited = vi.fn(async (_until: number) => {})
  const items = await granolaMcpItems({...f.options,rateLimited},request,async()=>{})
  expect(await items[1].read()).toMatchObject({summary:'Blue charts'})
  expect(rateLimited.mock.calls[0][0]).toBeGreaterThanOrEqual(before + 120_000)
  expect(rateLimited.mock.calls[0][0]).toBeLessThanOrEqual(Date.now() + 120_000)
  expect(attempts).toBe(3)
})

it('keeps notes and stops requesting transcripts after Granola reports the paid-plan restriction', async () => {
  const f = fixture('transcript-limited'), items = await f.items()
  expect(await items[1].read()).toMatchObject({summary:'Blue charts'})
  expect(await items[2].read()).not.toHaveProperty('transcript')
  expect(f.options.notesOnly).toHaveBeenCalledOnce()
  expect(f.words).toHaveBeenCalledOnce()
})
