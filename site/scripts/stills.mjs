// Browser-only asset export. Never imports Playwright or starts Electron.
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyWalkthroughFrames } from './walkthrough-frames.mjs'
import assert from 'node:assert/strict'

// Freeze the real fixture at the same beat as its dark WebP, keeping the shared app CSS.
function lightPoster() {
  const source = document.documentElement
  const copy = source.cloneNode(true)
  copy.dataset.marketingTheme = 'light'
  copy.style.colorScheme = 'light'
  copy.querySelectorAll('script, .marketing-cursor').forEach(node => node.remove())
  copy.querySelector('link[rel=stylesheet]').setAttribute('href', '/marketing/app/renderer.css')
  copy.querySelector('meta[http-equiv="Content-Security-Policy"]').content =
    "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; base-uri 'none'; form-action 'none'"
  for (const node of copy.querySelectorAll('body, #root')) node.style.colorScheme = 'light'
  const canvases = source.querySelectorAll('canvas')
  copy.querySelectorAll('canvas').forEach((canvas, index) => {
    const mask = document.createElement('span')
    mask.className = canvas.className
    mask.style.cssText = canvas.style.cssText
    mask.style.background = 'currentColor'
    mask.style.mask = 'url(' + canvases[index].toDataURL() + ') center / 100% 100% no-repeat'
    canvas.replaceWith(mask)
  })
  return '<!doctype html>\n' + copy.outerHTML + '\n'
}

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const origin = process.env.SITE_URL || 'http://127.0.0.1:43933'
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'Export only the local fictional site.')
const chromePath = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'yogurt-site-render-'))
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
let socket, counter = 0
const errors = []
const replies = new Map(), pause = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  const endpoint = await new Promise((resolve, reject) => {
    let log = ''
    const timeout = setTimeout(() => reject(new Error('Chrome did not start in 15 seconds')), 15000)
    chrome.stderr.on('data', chunk => { log += chunk; const match = log.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timeout); resolve(match[1]) } })
    chrome.once('error', reject); chrome.once('exit', code => { clearTimeout(timeout); reject(new Error(`Chrome exited: ${code}`)) })
  })
  socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data), pending = replies.get(message.id)
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
    if (pending) { replies.delete(message.id); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result) }
  }
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++counter; replies.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const call = (method, params) => send(method, params, sessionId)
  const evaluate = async expression => {
    const result=await call('Runtime.evaluate', { expression, returnByValue: true })
    assert(!result.exceptionDetails,result.exceptionDetails?.exception?.description)
    return result.result.value
  }
  await call('Page.enable'); await call('Runtime.enable')
  await verifyWalkthroughFrames(call, origin)
  const {createRequire}=await import('node:module')
  const require=createRequire(await fs.realpath(path.join(site,'node_modules/next/package.json'))),sharp=require('sharp')
  const {beats,timing}=await import('../renderer/timeline.mjs')
  // Check the write-in itself, so a final reset cannot conceal a scroll jolt.
  await call('Emulation.setDeviceMetricsOverride',{width:1000,height:608,deviceScaleFactor:2,mobile:false})
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]})
  await call('Page.navigate',{url:origin+'/marketing/app/frame.html'})
  await pause(1000)
  assert.equal(await evaluate('document.documentElement.dataset.ready'),'true')
  for(let tick=308;tick<=420;tick++) {
    await evaluate(`window.postMessage({type:'yogurt-hero-time',seconds:${tick/20}},location.origin)`)
    await pause(50)
    if(tick/20>=timing.summaryStart) {
      const top=await evaluate("document.querySelector('#note-notes-panel[aria-labelledby=note-summary-tab]')?.scrollTop")
      assert.equal(top,0,`live Summary must not scroll while writing (${tick/20}s)`)
    }
  }
  for(const seconds of [21,27]) {
    await evaluate(`window.postMessage({type:'yogurt-hero-time',seconds:${seconds}},location.origin)`)
    await pause(300)
    const resting=await evaluate(`(()=>{const editor=document.querySelector('[data-testid=note-enhanced-editor]'),pane=editor.closest('.note-notes-pane'),heading=editor.querySelector('h2');return {top:pane.scrollTop,headingVisible:heading.getBoundingClientRect().top>=pane.getBoundingClientRect().top,summaryFits:pane.scrollHeight<=pane.clientHeight+1,lastLineVisible:editor.lastElementChild.getBoundingClientRect().bottom<=pane.getBoundingClientRect().bottom-20,generating:pane.closest('.note-reading-frame').dataset.generating}})()`)
    assert.equal(resting.generating,'false')
    assert.equal(resting.top,0,'completed live Summary rests at the top, including during Ask')
    assert(resting.headingVisible,'the complete Summary heading stays below the tab bar')
    assert(resting.summaryFits && resting.lastLineVisible,'the complete Summary fits above the bottom fade')
  }
  assert.deepEqual(errors,[],'live Summary and Ask have no runtime errors')
  const { verifyFaqClearance } = await import('./faq-clearance.test.mjs')
  await verifyFaqClearance(call, origin)
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'},{name:'prefers-reduced-motion',value:'reduce'}]})
  const images={}, posters={}
  const {createHash}=await import('node:crypto')
  for (const [name,width,height] of [['desktop',1000,608],['phone',600,912]]) {
    const phone=name==='phone'
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:2,mobile:false})
    for (const [beat,time] of beats) {
      if(!['arrival','writing','answer'].includes(beat)||phone&&beat!=='answer')continue
      await call('Page.navigate',{url:origin+`/marketing/app/frame.html?still=${time}`})
      await pause(1000)
      const info=await evaluate(`({ready:document.documentElement.dataset.ready,text:document.body.innerText,overflow:document.documentElement.scrollWidth>innerWidth,bg:getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),loader:!!document.querySelector('.bubble .live-dots'),names:[...document.querySelectorAll('[data-testid="transcript-who"]')].map(e=>e.textContent),selected:document.querySelector('[role=tab][aria-selected=true]')?.textContent,questionSent:document.documentElement.dataset.questionSent,panelHeight:document.querySelector('[data-testid=chat-panel]')?.getBoundingClientRect().height,level:document.querySelector('[data-testid=note-wave]')?.dataset.level})`)
      console.log(name,beat,JSON.stringify(info))
      assert.deepEqual(errors,[],'the generated frame has no runtime errors')
      assert.equal(info.ready,'true','real renderer fixture is ready')
      const titleCenters = await evaluate(`['.marketing-traffic i', '.workspace-sidebar-toggle', 'button[aria-label="Back"]'].map(selector => {
        const rect = document.querySelector(selector).getBoundingClientRect()
        return rect.top + rect.height / 2
      })`)
      for (const center of titleCenters.slice(1)) assert(Math.abs(titleCenters[0] - center) <= 1, 'window buttons align with the title bar')
      assert(!info.text.includes('Planned'));assert(!info.overflow)
      assert.equal(info.bg.toLowerCase(),'#1b1b1d','only the frame is forced to app dark')
      assert(!info.text.includes('Let the others'),'no recording reminder in the demonstration')
      if (beat==='arrival') assert.equal(new Set(info.names).size,1)
      if(beat==='arrival')assert(info.level!==undefined,'native recording indicator is mounted in its reduced-motion still')
      if(beat==='writing') {
        assert(info.text.includes('Reading the transcript…'),'Summary shows the native reading state before text arrives')
        assert(await evaluate("!!document.querySelector('.summary-outline') && !document.querySelector('.ask-border')"),'Summary uses its faint outline without the old ring')
        continue
      }
      if(beat==='answer') {
        assert(await evaluate("!!document.querySelector('[data-testid=ask-scope]') && !!document.querySelector('[data-testid=chat-copy-answer]') && document.querySelector('.chat-answer-scope')?.textContent==='Searched Launch planning'"),'Ask shows its scope pill, Copy action and searched scope')
        const fits=await evaluate(`(()=>{const h=document.querySelector('.chat-history'),r=h.getBoundingClientRect();return h.scrollHeight<=h.clientHeight+1&&['chat-question','chat-answer','source-citation'].every(id=>{const a=document.querySelector('[data-testid='+id+']').getBoundingClientRect();return a.top>=r.top&&a.bottom<=r.bottom})})()`)
        assert(fits,'question, complete answer and citation must fit with no thread scroll')
      }
      const png=Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64')
      const files=[]
      if (beat==='arrival'&&!phone) files.push('hero-desktop.webp')
      if (beat==='answer') files.push(phone?'hero-phone.webp':'hero-finished-desktop.webp')
      for (const file of files) {
        const bytes=await sharp(png).webp({quality:90}).toBuffer()
        await fs.writeFile(path.join(site,'public/marketing/stills',file),bytes)
        images[file]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}
        const scene = phone ? 'phone' : beat === 'arrival' ? 'arrival' : 'answer'
        const poster = 'hero-light-' + scene + '.html'
        const markup = await evaluate('(' + lightPoster.toString() + ')()')
        await fs.writeFile(path.join(site, 'public/marketing/stills', poster), markup)
        posters[poster] = {bytes:Buffer.byteLength(markup),sha256:createHash('sha256').update(markup).digest('hex')}
      }
    }
  }
  await call('Emulation.setDefaultBackgroundColorOverride',{color:{r:0,g:0,b:0,a:0}})
  for (const kind of ['transcript','summary','ask']) {
    for (const theme of ['light','dark']) {
      for (const [device,width,height] of [['desktop',420,250],['phone',320,280]]) {
        await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:2,mobile:false})
        await call('Page.navigate',{url:origin+`/marketing/app/frame.html?fragment=${kind}&still=99&theme=${theme}`})
        await pause(900)
        assert.deepEqual(errors,[],'fragment components have no runtime errors')
        const info=await evaluate(`(()=>{const e=document.querySelector('.marketing-fragment'),r=e.getBoundingClientRect();return {ready:document.documentElement.dataset.ready,text:e.innerText,top:r.top,bottom:r.bottom,bg:getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()}})()`)
        console.log(kind,device,JSON.stringify(info))
        assert.equal(info.ready,'true');assert(info.top>=0&&info.bottom<=height,'fragment must fit at the app type size')
        assert.equal(info.bg.toLowerCase()==='#1b1b1d',theme==='dark','fragments follow the requested theme')
        if(kind==='ask')assert.equal(await evaluate("document.querySelectorAll('[data-testid=source-citation]').length"),1)
        const file=`fragment-${kind}${theme==='dark'?'-dark':''}-${device}.webp`
        const png=Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'),bytes=await sharp(png).webp({quality:90}).toBuffer()
        await fs.writeFile(path.join(site,'public/marketing/stills',file),bytes)
        images[file]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}
      }
    }
  }

  const manifest=JSON.parse(await fs.readFile(path.join(site,'public/marketing/app/manifest.json'),'utf8'))
  await fs.writeFile(path.join(site,'public/marketing/stills/manifest.json'),JSON.stringify({appCommit:manifest.appCommit,bundleSha256:manifest.files['renderer.js'].sha256,bundleCssSha256:manifest.files['renderer.css'].sha256,generatedAt:new Date().toISOString(),images,posters},null,2)+'\n')

} finally {
  socket?.close(); chrome.kill()
  await pause(300)
  await fs.rm(profile, {recursive:true,force:true})
}
