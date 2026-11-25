import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { connectGranola, granolaCallback, granolaResource, refreshGranola } from '../src/main/granolaOAuth'

const issuer = 'https://mcp-auth.granola.ai'
const uri = 'http://127.0.0.1:39999/granola/callback'
const discovery = { issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token',
  registration_endpoint: issuer + '/register', code_challenge_methods_supported: ['S256'], scopes_supported: ['offline_access'] }
function service(overrides = {}) {
  return vi.fn<typeof fetch>(async (url) => {
    if (String(url).includes('oauth-protected-resource')) return Response.json({ resource: granolaResource, authorization_servers: [issuer], scopes_supported: ['mcp'] })
    if (String(url).includes('oauth-authorization-server')) return Response.json({ ...discovery, ...overrides })
    if (String(url).endsWith('/register')) return Response.json({ client_id:'public-id' })
    if (String(url).endsWith('/token')) return Response.json({ token_type:'Bearer', access_token:'fiction', refresh_token:'rotated', expires_in:3600 })
    throw Error('Unexpected request')
  })
}

it('registers a public client and binds the browser request and grant to this callback, resource and S256 verifier', async () => {
  const request = service(), open = vi.fn(async (_url: string) => {}), close = vi.fn()
  const listen = vi.fn(async (_state: string) => ({ uri, reply:Promise.resolve({code:'fictional-code',error:null}), close }))
  const connection = await connectGranola(open, AbortSignal.timeout(1000), request, listen)
  const browser = new URL(open.mock.calls[0][0])
  expect(browser.origin).toBe(issuer)
  expect(browser.searchParams.get('state')).toBe(listen.mock.calls[0][0])
  const registration = JSON.parse(String(request.mock.calls[2][1]?.body))
  expect(registration).toMatchObject({ token_endpoint_auth_method:'none', redirect_uris:[uri] })
  const grant = request.mock.calls[3][1]?.body as URLSearchParams
  expect(grant.get('resource')).toBe(granolaResource)
  expect(grant.get('redirect_uri')).toBe(uri)
  expect(grant.has('client_secret')).toBe(false)
  expect(browser.searchParams.get('code_challenge')).toBe(createHash('sha256').update(grant.get('code_verifier')!).digest('base64url'))
  expect(browser.searchParams.get('code_challenge_method')).toBe('S256')
  expect(connection).toMatchObject({ refresh:'rotated', clientId:'public-id' })
  expect(close).toHaveBeenCalledOnce()
  await refreshGranola(connection, request)
  const refresh = request.mock.lastCall![1]?.body as URLSearchParams
  expect(refresh.get('grant_type')).toBe('refresh_token')
  expect(refresh.get('refresh_token')).toBe('rotated')
})

it('closes the pending attempt on denial and rejects unexpected discovery endpoints before opening the browser', async () => {
  const open = vi.fn(async () => {}), close = vi.fn()
  const listen = vi.fn(async () => ({uri, reply:Promise.resolve(null), close}))
  await expect(connectGranola(open, AbortSignal.timeout(1000), service(), listen)).rejects.toThrow(/denied access/)
  expect(close).toHaveBeenCalledOnce()
  await expect(connectGranola(open, AbortSignal.timeout(1000), service({token_endpoint:'https://example.invalid/token'}), listen)).rejects.toThrow(/response/)
  expect(open).toHaveBeenCalledOnce()
})

it('accepts only the callback for this attempt', () => {
  const path = '/granola/callback?state=fiction&code=ok', host = new URL(uri).host
  expect(granolaCallback(uri,'fiction',path,host)).toEqual({code:'ok',error:null})
  expect(granolaCallback(uri,'fiction',path,'localhost')).toBeUndefined()
  expect(granolaCallback(uri,'other',path,host)).toBeUndefined()
  expect(granolaCallback(uri,'fiction',path + '&iss=https://example.invalid',host)).toBeUndefined()
  expect(granolaCallback(uri,'fiction','/other?state=fiction',host)).toBeUndefined()
})

it('uses issuer defaults if the resource scopes are explicitly rejected', async () => {
  const open = vi.fn(async (_url: string) => {}), close = vi.fn()
  const listen = vi.fn().mockResolvedValueOnce({uri,reply:Promise.resolve({error:'invalid_scope',code:null}),close})
    .mockResolvedValueOnce({uri,reply:Promise.resolve({error:null,code:'fiction'}),close})
  await connectGranola(open, AbortSignal.timeout(1000), service(), listen)
  expect(new URL(open.mock.calls[0][0]).searchParams.get('scope')).toBe('mcp offline_access')
  expect(new URL(open.mock.calls[1][0]).searchParams.has('scope')).toBe(false)
  expect(close).toHaveBeenCalledTimes(2)
})
