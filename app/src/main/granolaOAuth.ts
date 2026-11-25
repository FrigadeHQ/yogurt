import { randomBytes, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { t } from '../shared/i18n'
import { Refusal } from './mcp/args'

export const granolaResource = 'https://mcp.granola.ai/mcp'
const issuer = 'https://mcp-auth.granola.ai'
export class GranolaDenied extends Refusal {}
export const accessDenied = () => new GranolaDenied(t('Granola denied access. Check your workspace settings or use CSV.'))
export class GranolaReconnect extends Refusal {}
export const signInAgain = () => new GranolaReconnect(t('Connect Granola again to import your notes.'))
const badResponse = () => new Refusal(t("Couldn't read Granola's response."))

export type GranolaConnection = { clientId: string; access: string; refresh?: string; expires?: number }

function authUrl(value: unknown): string {
  if (typeof value !== 'string') throw badResponse()
  const url = new URL(value)
  if (url.origin !== issuer || url.username || url.password || url.hash) throw badResponse()
  return url.href
}

async function metadata(request: typeof fetch, signal: AbortSignal) {
  const read = async (url: string) => {
    const r = await request(url, { redirect: 'error', signal })
    if (!r.ok) throw r.status === 403 ? accessDenied() : badResponse()
    return r.json()
  }
  const resource = await read('https://mcp.granola.ai/.well-known/oauth-protected-resource/mcp')
  if (resource.resource !== granolaResource || !Array.isArray(resource.authorization_servers) || !resource.authorization_servers.includes(issuer)) throw badResponse()
  const auth = await read(issuer + '/.well-known/oauth-authorization-server')
  if (auth.issuer !== issuer || !auth.code_challenge_methods_supported?.includes('S256')) throw badResponse()
  const scopes = Array.isArray(resource.scopes_supported) && resource.scopes_supported.includes('mcp') ? ['mcp'] : []
  if (auth.scopes_supported?.includes('offline_access')) scopes.push('offline_access')
  return { register: authUrl(auth.registration_endpoint), authorize: authUrl(auth.authorization_endpoint), token: authUrl(auth.token_endpoint), scope: scopes.join(' ') }
}

/** Ignore unrelated local requests. Only this attempt's path, port, issuer and state can complete it. */
export function granolaCallback(uri: string, state: string, requestUrl: string, host: string) {
  const url = new URL(requestUrl, uri)
  if (host !== new URL(uri).host || url.origin + url.pathname !== uri || url.searchParams.get('state') !== state) return
  if (url.searchParams.has('iss') && url.searchParams.get('iss') !== issuer) return
  return { code: url.searchParams.get('code'), error: url.searchParams.get('error') }
}

async function loopback(state: string, signal: AbortSignal) {
  let uri = ''
  type Reply = NonNullable<ReturnType<typeof granolaCallback>>
  let finish!: (reply: Reply | null) => void
  const reply = new Promise<Reply | null>(resolve => { finish = resolve })
  const server = createServer((req, res) => {
    let result: ReturnType<typeof granolaCallback>
    try { if (req.method === 'GET' && uri) result = granolaCallback(uri, state, req.url || '/', req.headers.host || '') } catch { /* invalid local request */ }
    res.writeHead(result ? 200 : 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Connection': 'close' })
    res.end(result ? t('Return to Yogurt.') : '')
    if (result) finish(result)
  })
  const close = () => { server.close(); server.closeAllConnections(); finish(null) }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  server.on('error', close)
  uri = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/granola/callback'
  signal.addEventListener('abort', close, { once: true })
  if (signal.aborted) close()
  return { uri, reply, close: () => { signal.removeEventListener('abort', close); close() } }
}

async function exchange(endpoint: string, clientId: string, form: Record<string, string>, signal: AbortSignal, request: typeof fetch, oldRefresh?: string): Promise<GranolaConnection> {
  const r = await request(endpoint, { method: 'POST', redirect: 'error', signal,
    body: new URLSearchParams({ ...form, client_id: clientId, resource: granolaResource }) })
  if (!r.ok) {
    const { error } = await r.json().catch(() => ({}))
    if (r.status === 401 || error === 'invalid_grant' || error === 'invalid_client') throw signInAgain()
    throw r.status === 403 || error === 'access_denied' ? accessDenied() : badResponse()
  }
  const token = await r.json()
  if (typeof token.access_token !== 'string' || !token.access_token || String(token.token_type).toLowerCase() !== 'bearer') throw badResponse()
  return { clientId, access: token.access_token, refresh: typeof token.refresh_token === 'string' ? token.refresh_token : oldRefresh,
    expires: typeof token.expires_in === 'number' ? Date.now() + token.expires_in * 1000 : undefined }
}

export async function connectGranola(open: (url: string) => Promise<void>, signal: AbortSignal, request = fetch, listen = loopback) {
  const auth = await metadata(request, signal)
  // Some issuers advertise different scopes from the resource. Retry only an explicit invalid_scope with the issuer defaults.
  for (const scope of [...new Set([auth.scope, ''])]) {
    const verifier = randomBytes(48).toString('base64url')
    const state = randomBytes(32).toString('base64url')
    const callback = await listen(state, signal)
    try {
      const r = await request(auth.register, { method: 'POST', redirect: 'error', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'Yogurt', redirect_uris: [callback.uri], grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'], token_endpoint_auth_method: 'none', ...(scope && { scope }) }) })
      if (!r.ok) {
        if (scope && r.status === 400 && (await r.json().catch(() => ({}))).error === 'invalid_scope') continue
        throw accessDenied()
      }
      const { client_id: clientId } = await r.json()
      if (typeof clientId !== 'string' || !clientId) throw badResponse()
      const url = new URL(auth.authorize)
      url.search = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: callback.uri, resource: granolaResource,
        ...(scope ? { scope } : {}), state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString()
      signal.throwIfAborted()
      await open(url.href)
      const reply = await callback.reply
      if (scope && reply?.error === 'invalid_scope') continue
      if (reply?.error || !reply?.code) throw accessDenied()
      const code = reply.code
      return await exchange(auth.token, clientId, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: callback.uri }, signal, request)
    } finally { callback.close() }
  }
  throw accessDenied()
}

export async function refreshGranola(connection: GranolaConnection, request = fetch) {
  if (!connection.refresh) throw signInAgain()
  const signal = AbortSignal.timeout(30_000)
  const auth = await metadata(request, signal)
  return exchange(auth.token, connection.clientId, { grant_type: 'refresh_token', refresh_token: connection.refresh }, signal, request, connection.refresh)
}
