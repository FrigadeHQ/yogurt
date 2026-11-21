// A tiny desktop stand-in for YogurtKit's interop tests: runs the pairing exchange and then Noise KK echo
// sessions with the real companion crypto from src/main/companion.
//   node app/scripts/companion-peer.mjs desktop <port> [code]
// Prints JSON lines: {"listening": port}, then {"paired": {isk, phoneKey, desktopKey}} or {"pairFail": reason}.
// Not shipped; test use only. The modules use extensionless imports, so they're bundled with esbuild first.
import { build } from 'esbuild'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [role, portArg, code = '482913'] = process.argv.slice(2)
if (role !== 'desktop' || portArg === undefined) {
  console.error('usage: companion-peer.mjs desktop <port> [code]')
  process.exit(2)
}

const companion = join(dirname(fileURLToPath(import.meta.url)), '../src/main/companion')
const dir = mkdtempSync(join(tmpdir(), 'companion-peer-'))
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0))
const outfile = join(dir, 'companion.mjs')
await build({
  stdin: {
    contents: ['sodium', 'cpace', 'noise', 'box'].map((m) => `export * from './${m}'`).join('\n'),
    resolveDir: companion, loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error',
})
const { ready, cpaceStart, cpaceFinish, pairKeys, sealBox, openBox, generateKeyPair, NoiseKK } = await import(pathToFileURL(outfile).href)
await ready()

const report = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const enc = (s) => new TextEncoder().encode(s)
const b64 = (b) => Buffer.from(b).toString('base64')
const unb64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'))
const hex = (b) => Buffer.from(b).toString('hex')
const concat = (...p) => Uint8Array.from(Buffer.concat(p))

const desktop = generateKeyPair()
const desktopId = hex(crypto.getRandomValues(new Uint8Array(8)))
let phoneKey = null

/** Frames on a socket: 2-byte big-endian length + payload. `next()` resolves with the next payload. */
function framed(socket) {
  let buf = Buffer.alloc(0)
  const queue = [], waiting = []
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
      const frame = Uint8Array.from(buf.subarray(2, 2 + buf.readUInt16BE(0)))
      buf = buf.subarray(2 + frame.length)
      waiting.length ? waiting.shift().resolve(frame) : queue.push(frame)
    }
  })
  const fail = () => { while (waiting.length) waiting.shift().reject(new Error('closed')) }
  socket.on('close', fail)
  socket.on('error', fail)
  return {
    next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => waiting.push({ resolve, reject })),
    send: (payload) => {
      const len = Buffer.alloc(2)
      len.writeUInt16BE(payload.length)
      socket.write(Buffer.concat([len, payload]))
    },
  }
}

const json = async (f) => JSON.parse(new TextDecoder().decode(await f.next()))
const sendJson = (f, o) => f.send(enc(JSON.stringify(o)))

async function pair(f) {
  const hello = await json(f)
  if (hello.type !== 'pairHello') throw new Error('expected pairHello')
  const phoneSession = unb64(hello.phoneSession)
  const desktopSession = crypto.getRandomValues(new Uint8Array(16))
  const sid = concat(desktopSession, phoneSession)
  const ci = concat(enc('yogurt-pair-v1'), desktopSession, phoneSession)
  const { ya, secret } = cpaceStart(code, ci, sid)
  sendJson(f, { type: 'pairStart', v: 1, desktopSession: b64(desktopSession), desktopId, desktopName: 'Test Mac', ya: b64(ya) })
  const reply = await json(f)
  const isk = cpaceFinish(secret, unb64(reply.yb))
  const keys = pairKeys(isk)
  const mine = enc(JSON.stringify({ key: b64(desktop.publicKey), name: 'Test Mac', id: desktopId }))
  sendJson(f, { type: 'pairConfirm', box: b64(sealBox(keys.toPhone, mine, enc('pairConfirm'))) })
  const done = await json(f)
  let phone
  try {
    phone = JSON.parse(new TextDecoder().decode(openBox(keys.toDesktop, unb64(done.box), enc('pairDone'))))
  } catch {
    sendJson(f, { type: 'pairFail', reason: 'code' })
    report({ pairFail: 'code' })
    return
  }
  phoneKey = unb64(phone.key)
  sendJson(f, { type: 'pairOk' })
  report({ paired: { isk: hex(isk), phoneKey: hex(phoneKey), desktopKey: hex(desktop.publicKey) } })
}

async function echo(f) {
  const noise = new NoiseKK({ initiator: false, s: desktop, rs: phoneKey, prologue: enc('yogurt-v1') })
  noise.readMessage(await f.next())
  f.send(noise.writeMessage(new Uint8Array(0)))
  const { send, recv } = noise.split()
  for (;;) f.send(send.encrypt(recv.decrypt(await f.next())))
}

// until a phone is paired every connection is a pairing attempt; after that, a Noise session
const server = createServer((socket) => {
  const f = framed(socket)
  ;(phoneKey ? echo(f) : pair(f)).catch((err) => { if (err.message !== 'closed') console.error('companion-peer:', err.message) }).finally(() => socket.end())
})
server.listen(Number(portArg), '127.0.0.1', () => report({ listening: server.address().port }))
// the test owns this process: when it goes away, so does the peer
process.stdin.on('end', () => process.exit(0)).resume()
