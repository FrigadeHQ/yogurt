// Run with Electron, never the packaged app's main entry. No models, microphone or real profile are opened.
// electron scripts/engine-smoke.cjs /path/to/app.asar
const { app, utilityProcess } = require('electron')
const { mkdtempSync, rmSync, existsSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')

const archive = process.argv[2]
if (!archive || !existsSync(archive)) throw new Error('Pass the packaged app.asar path')
const profile = mkdtempSync(join(tmpdir(), 'yogurt-engine-smoke-'))
app.setName('Yogurt Engine Smoke')
app.setPath('userData', profile)

app.whenReady().then(() => {
  // Linux: the shipped allocator shim (#32), preloaded the way src/main/engine.ts does it
  const shim = process.platform === 'linux' ? join(dirname(resolve(archive)), 'bin', 'libyogurt-bigalloc.so') : undefined
  if (shim && !existsSync(shim)) throw new Error(`${shim} is not in the package`)
  const env = shim ? { env: { ...process.env, LD_PRELOAD: shim } } : {}
  const child = utilityProcess.fork(join(resolve(archive), 'out/main/engine.js'), [], { serviceName: 'Yogurt Engine Smoke', stdio: 'pipe', ...env })
  let stderr = '', settled = false
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-16_384) })
  child.stdout.resume()
  const finish = (error) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (error) console.error(`${error}\n${stderr}`)
    else console.log('Packaged notes engine imported its dependencies and answered over IPC')
    child.kill()
    // Windows can still hold the profile's files just after the kill; a leftover temp folder must not keep Electron open
    try { rmSync(profile, { recursive: true, force: true }) } catch { /* temp folder */ }
    app.exit(error ? 1 : 0)
  }
  const timer = setTimeout(() => finish('Packaged notes engine did not answer within 15 seconds'), 15_000)
  child.on('exit', (code) => finish(`Packaged notes engine exited before answering (code ${code})`))
  child.on('message', (event) => {
    if (event.id !== 1) return
    // The expected error proves the real worker reached its handler without loading a model.
    if (event.type !== 'error' || event.message !== 'No model loaded') return finish(`Unexpected packaged engine response: ${JSON.stringify(event)}`)
    // the utility process must really have loaded it: Electron passes env to it at exec
    if (shim && !readFileSync(`/proc/${child.pid}/maps`, 'utf8').includes(shim)) return finish(`The notes engine did not load ${shim}`)
    if (shim) console.log(`The notes engine loaded ${shim}`)
    finish(null)
  })
  child.postMessage({ id: 1, type: 'count', texts: ['packaged startup check'] })
}).catch((error) => { console.error(error); rmSync(profile, { recursive: true, force: true }); app.exit(1) })
