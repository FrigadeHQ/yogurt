import { pathToFileURL } from 'node:url'
import { pageUrls } from './site-urls.mjs'

const host = 'yogurt.so'
const key = '80136ef773ad0e698e159c2c0af1c24a'

export async function submitIndexNow(env, request = fetch) {
  if (env.VERCEL !== '1' || env.VERCEL_ENV !== 'production' || env.VERCEL_GIT_COMMIT_REF !== 'main')
    return 'skipped outside a production deploy of main'

  try {
    const response = await request('https://api.indexnow.org/indexnow', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
      body: JSON.stringify({ host, key, keyLocation: `https://${host}/${key}.txt`, urlList: pageUrls }),
      signal: AbortSignal.timeout(1000),
    })
    if (response.status === 403) return 'HTTP 403; the public key may not be live yet'
    return `HTTP ${response.status} for ${pageUrls.length} public URLs`
  } catch {
    return 'request timed out or failed; continuing'
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('IndexNow: ' + await submitIndexNow(process.env))
}
