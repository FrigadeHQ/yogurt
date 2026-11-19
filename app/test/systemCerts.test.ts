import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { join } from 'node:path'
import * as tls from 'node:tls'
import { trustSystemCertificates } from '../src/main/systemCerts'

// A company that inspects HTTPS re-signs every site with its own certificate, which IT installs in Windows or macOS.
// Node only trusts its own bundled list, so the model downloads failed there (#115). The fixtures are a made-up CA.
const dir = join(__dirname, 'fixtures/tls')
const ca = readFileSync(join(dir, 'ca.pem'), 'utf8')
const original = tls.getCACertificates('default')
let server: Server | undefined

afterEach(() => { tls.setDefaultCACertificates(original); server?.close(); server = undefined })

async function serve(): Promise<string> {
  server = createServer({ key: readFileSync(join(dir, 'server.key')), cert: readFileSync(join(dir, 'server.pem')) }, (_q, r) => r.end('model bytes'))
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok))
  const { port } = server.address() as { port: number }
  return `https://127.0.0.1:${port}/`
}

describe('the certificates the computer trusts (#115)', () => {
  it('a download signed by a certificate installed in the system works once Yogurt trusts the system', async () => {
    const url = await serve()
    await expect(fetch(url)).rejects.toThrow()
    const added = trustSystemCertificates({ ...tls, getCACertificates: (k) => (k === 'system' ? [ca] : tls.getCACertificates(k)) })
    expect(added).toBe(1)
    expect(await (await fetch(url)).text()).toBe('model bytes')
  })
  it('keeps the bundled list, so the usual sites still work', () => {
    trustSystemCertificates({ ...tls, getCACertificates: (k) => (k === 'system' ? [ca] : tls.getCACertificates(k)) })
    expect(tls.getCACertificates('default').length).toBe(original.length + 1)
  })
  it('never stops start-up when the system list cannot be read', () => {
    expect(trustSystemCertificates({ ...tls, getCACertificates: () => { throw new Error('no store') } })).toBe(0)
  })
})
