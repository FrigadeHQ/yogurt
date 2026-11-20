import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { platforms, release } from '../public/marketing/downloads.mjs'

const guide = readFileSync(new URL('../public/llms.txt', import.meta.url), 'utf8')
const targets = [...guide.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)].map(match => match[1])
assert(targets.length > 0, 'The guide must link to the project.')
const shell = readFileSync(new URL('../content/shell.html', import.meta.url), 'utf8')
assert.equal(shell.match(/href="\/llms\.txt"/g)?.length, 1)
assert.match(shell, /class="footer-bottom"[^]*?<a class="link-label" href="\/llms\.txt">llms\.txt<\/a>/)

// The index includes documentation even when only site/ is checked out.
const files = new Set(execFileSync('git', ['ls-files', '-z'], {
  cwd: new URL('../../', import.meta.url), encoding: 'utf8',
}).split('\0'))
const repo = 'https://github.com/FrigadeHQ/yogurt'
const destinations = new Set([repo, repo + '/issues', repo + '/releases', 'https://frigade.com/'])
for (const platform of Object.values(platforms)) destinations.add(release + platform.file)
for (const target of targets) {
  const url = new URL(target)
  let exists = destinations.has(target)
  if (url.origin === 'https://yogurt.so') {
    const path = url.pathname.replace(/^\/|\/$/g, '')
    exists = files.has('site/app/' + (path ? path + '/' : '') + 'route.ts') || files.has('site/public/' + path)
  } else if (target.startsWith(repo + '/blob/main/')) {
    exists = files.has(decodeURIComponent(url.pathname.slice('/FrigadeHQ/yogurt/blob/main/'.length)))
  }
  assert(exists, 'Unknown llms.txt destination: ' + target)
}
if (process.argv.includes('--live')) {
  await Promise.all([...new Set(targets)].map(async target => {
    const response = await fetch(target, {method: 'HEAD', signal: AbortSignal.timeout(20000)})
    assert(response.ok, target + ' returned ' + response.status)
  }))
}
console.log(targets.length + ' llms.txt destinations and the shared footer link passed.')
