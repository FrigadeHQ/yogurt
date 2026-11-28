import { createLlm } from './llm'
import { createHandler } from './handler'
import type { EngineEvent, EngineRequest } from '../shared/engine-protocol'

/** The notes model's process: requests from the main process (src/main/engine.ts) */
const send = (e: EngineEvent) => process.parentPort.postMessage(e)
const handle = createHandler(createLlm({ log: (level, text) => send({ type: 'log', level, text }) }), send)
process.parentPort.on('message', ({ data }: { data: EngineRequest }) => { void handle(data) })
