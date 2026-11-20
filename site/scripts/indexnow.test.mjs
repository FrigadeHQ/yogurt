import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { submitIndexNow } from './submit-indexnow.mjs'
import { pageUrls } from './site-urls.mjs'

const prod = { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main' }
let requests = 0
const send = async (endpoint, options) => {
  requests++
  assert.equal(endpoint, 'https://api.indexnow.org/indexnow')
  assert.equal(options.method, 'POST')
  assert(options.signal instanceof AbortSignal)
  const body = JSON.parse(options.body)
  assert.deepEqual(body.urlList, pageUrls)
  assert.equal(body.host, 'yogurt.so')
  assert.match(body.key, /^[a-f0-9]{32}$/)
  assert.equal(body.keyLocation, 'https://yogurt.so/' + body.key + '.txt')
  assert.equal(readFileSync(new URL('../public/' + body.key + '.txt', import.meta.url), 'utf8').trim(), body.key)
  return { status: 202 }
}
for (const env of [{}, { ...prod, VERCEL: '' }, { ...prod, VERCEL_ENV: 'preview' }, { ...prod, VERCEL_GIT_COMMIT_REF: 'feature' }])
  assert.match(await submitIndexNow(env, send), /skipped/)
assert.equal(requests, 0)
assert.match(await submitIndexNow(prod, send), /202/)
assert.equal(requests, 1)
assert.match(await submitIndexNow(prod, async () => ({ status: 403 })), /key/)
assert.match(await submitIndexNow(prod, async () => { throw Error('offline') }), /continuing/)
console.log('IndexNow permits only production main, uses its published key, and tolerates submission failures.')
