// libsodium (sumo build: it has ristretto255). Plain Node, no Electron, so scripts and tests can import it too.
import lib from 'libsodium-wrappers-sumo'

let loaded = false

/** Await once before calling anything in companion/; the library loads its WebAssembly asynchronously. */
export async function ready(): Promise<typeof lib> {
  await lib.ready
  loaded = true
  return lib
}

/** The loaded library; throws instead of failing obscurely when ready() was never awaited. */
export function sodium(): typeof lib {
  if (!loaded) throw new Error('companion crypto used before ready()')
  return lib
}
