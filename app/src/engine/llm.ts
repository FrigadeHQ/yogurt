import { getLlama, Gemma4ChatWrapper, InsufficientMemoryError, LlamaChatSession, type ChatHistoryItem, type Llama, type LlamaContext, type LlamaContextSequence, type LlamaEmbeddingContext, type LlamaModel } from 'node-llama-cpp'
import { cleanAnswer, streamCleaner } from './control'
import { samplingFor } from './sampling'
import { holds } from './prefix'
import { engineThreads } from './threads'
import { vramCap } from './vram'
import { availableParallelism } from 'node:os'
import { outOfGraphicsMemory, type EngineMessage } from '../shared/engine-protocol'

const toHistory = (messages: EngineMessage[]): ChatHistoryItem[] =>
  messages.map((m) => (m.role === 'system' ? { type: 'system', text: m.content } : m.role === 'user' ? { type: 'user', text: m.content } : { type: 'model', response: [m.content] }))

/**
 * The notes model itself: load, count tokens, write. Used by the worker process. Callers run one thing at a time (the worker's serial()).
 */
export function createLlm(o: { platform?: string } = {}) {
  const platform = o.platform ?? process.platform
  let llama: Llama | undefined
  /** the processor alone, when the graphics have no room at all (#57) */
  let cpuLlama: Llama | undefined
  let model: LlamaModel | undefined
  let context: LlamaContext | undefined
  /** One sequence for the model's whole life: a request that starts like the last one only reads what's new */
  let main: LlamaContextSequence | undefined
  /** the embedding model (meaning search across meetings): small, its own context, kept until let go */
  let embedder: { path: string; model: LlamaModel; context: LlamaEmbeddingContext } | undefined
  // YOGURT_ENGINE_GPU=off: the graphics card crashed the engine before, on Windows or Linux; =vulkan: the default
  // (CUDA) build found no card but Vulkan did (#32). Both come from src/main/engine.ts.
  const gpu = process.env.YOGURT_ENGINE_GPU
  /** the graphics memory as node-llama-cpp found it, before the cap below: what the probe reports */
  let found: { total: number; unifiedSize: number } | undefined
  /** plans only for the card's own memory, less room for whisper-server (#165: a 4 GB card counted as 21 GB) */
  const fitCard = async (l: Llama): Promise<Llama> => {
    if (!l.gpu) return l
    found = await l.getVramState()
    const cap = vramCap(found, platform)
    if (cap !== null) { await l.setVramCap(cap); console.info(`notes engine: plans for ${(cap / 1024 ** 3).toFixed(1)} GiB of graphics memory`) }
    return l
  }
  const getL = async (): Promise<Llama> => {
    if (!llama) llama = await fitCard(await getLlama(gpu === 'off' ? { gpu: false } : gpu === 'vulkan' ? { gpu: 'vulkan' } : undefined))
    return llama
  }
  // Gemma's auto wrapper requests thinking; a zero token budget cuts it off instead of disabling it.
  const threads = (l: Llama) => { const n = engineThreads(process.platform, l.cpuMathCores, availableParallelism()); return n === undefined ? {} : { threads: n } }
  const chatWrapper = () => model?.fileInfo.metadata.general.architecture === 'gemma4' ? new Gemma4ChatWrapper({ reasoning: false }) : 'auto' as const

  const unload = async () => {
    main = undefined
    await context?.dispose(); context = undefined
    await model?.dispose(); model = undefined
  }

  const unloadEmbed = async () => {
    const e = embedder
    embedder = undefined
    await e?.context.dispose()
    await e?.model.dispose()
  }

  return {
    /** the graphics this engine can use: a Mac never asks */
    async probe() {
      const l = await getL()
      // as found, not as capped: the picker takes the card's own memory from it (main/hardware.ts)
      const v = found ?? await l.getVramState()
      const GB = 1e9
      return { gpuType: l.gpu, vramTotalGB: v.total / GB, unifiedGB: v.unifiedSize / GB, gpuNames: await l.getGpuDeviceNames() }
    },
    unload,
    unloadEmbed,
    /** each text's embedding, as the model gives it (main cuts it to length and normalises it) */
    async embed(modelPath: string, texts: string[]): Promise<number[][]> {
      if (embedder?.path !== modelPath) {
        await unloadEmbed()
        const l = await getL()
        const model = await l.loadModel({ modelPath })
        // a chunk is about 300 words: well inside the model's own 2,048 tokens
        embedder = { path: modelPath, model, context: await model.createEmbeddingContext({ contextSize: Math.min(2048, model.trainContextSize), ...threads(l) }) }
      }
      const out: number[][] = []
      for (const t of texts) out.push(Array.from((await embedder.context.getEmbeddingFor(t)).vector))
      return out
    },
    /** gpu: what it runs on (cuda, vulkan, metal, or false: the processor alone), for the log */
    /** maxGpuLayers: the most layers on the card, after it ran out of memory with more (#165); 0: the processor alone */
    async load(modelPath: string, contextSize: number, minContext: number, maxGpuLayers?: number): Promise<{ contextSize: number; gpu: string | false; gpuLayers: number }> {
      await unload()
      // the processor alone never touches the graphics
      const l = maxGpuLayers === 0 ? (cpuLlama ??= await getLlama({ gpu: false })) : await getL()
      const size = { min: Math.min(minContext, contextSize), max: contextSize }
      // The model fills the graphics card first and keeps room for only a tiny context; on a card with little memory the
      // notes' context then doesn't fit (InsufficientMemoryError, every summary failing). So: load again leaving room for
      // the smallest context we accept, then with nothing on the card. A computer where it fits loads once, as before.
      // A model that doesn't fit on the card at all can fail to load outright (#37): that gets the same fewer layers.
      // Integrated graphics can say the context won't fit even with no layers on them (an Intel Arc, #57): last, the
      // graphics are left out altogether and the processor does it all.
      // With a cap the same steps, never over it.
      const max = maxGpuLayers ? { max: maxGpuLayers } : {}
      type Step = { cpu?: true; gpuLayers?: { max?: number; fitContext?: { contextSize: number } } | 0 }
      const steps: Step[] = maxGpuLayers === 0 ? [{ cpu: true }]
        : [maxGpuLayers ? { gpuLayers: max } : {}, { gpuLayers: { ...max, fitContext: { contextSize: size.min } } }, { gpuLayers: 0 }, ...(l.gpu ? [{ cpu: true as const }] : [])]
      let used = l
      for (const [i, step] of steps.entries()) {
        const last = i === steps.length - 1
        used = step.cpu ? (cpuLlama ??= await getLlama({ gpu: false })) : l
        try { model = await used.loadModel(step.gpuLayers === undefined ? { modelPath } : { modelPath, gpuLayers: step.gpuLayers }) } catch (e) {
          if (last) throw e
          console.warn('the notes model did not load; loading it again with fewer layers on the graphics', (e as Error).message)
          continue
        }
        try { context = await model.createContext({ contextSize: size, ...threads(used) }) } catch (e) {
          if (!(e instanceof InsufficientMemoryError) || last) throw e
          console.warn('the notes did not fit next to the model; loading it again with fewer layers on the graphics', e.message)
          await model.dispose(); model = undefined
          continue
        }
        main = context.getSequence()
        // the first evaluation pages the weights in from disk: pay it here, not on the first word of the notes. The card
        // can run out of memory only now, as it first computes (#165): fewer layers again.
        try { await main.evaluateWithoutGeneratingNewTokens(model.tokenize('Hello')); break } catch (e) {
          if (!outOfGraphicsMemory((e as Error).message) || last) throw e
          console.warn('the graphics card ran out of memory reading in; loading it again with fewer layers on the graphics', (e as Error).message)
          main = undefined
          await context.dispose(); context = undefined
          await model.dispose(); model = undefined
        }
      }
      if (!model || !context || !main) throw new Error('The notes model did not load')
      return { contextSize: context.contextSize, gpu: model.gpuLayers === 0 ? false : used.gpu, gpuLayers: model.gpuLayers }
    },
    count(texts: string[]): number[] {
      if (!model) throw new Error('No model loaded')
      return texts.map((t) => model!.tokenize(t).length)
    },
    /**
     * Reads a conversation in without answering: the last (user) message only as far as its text goes, as the start
     * of a prompt to come. A chat that starts the same way then only reads the rest. The read itself can't be
     * stopped once it started (node-llama-cpp evaluates it whole): callers keep each one small.
     */
    async preload(messages: EngineMessage[], signal?: AbortSignal, onTiming?: (text: string) => void): Promise<number> {
      if (!main) throw new Error('No model loaded')
      const last = messages.at(-1)
      if (!last || last.role !== 'user') throw new Error('Last message must be from the user')
      // already read (or more): reading it again would drop what comes after it
      if (messages.length === 1 && holds(main.contextTokens, model!.tokenize(last.content))) return 0
      const t0 = performance.now(), read0 = main.tokenMeter.usedInputTokens
      // the same session set-up as chat(), or what is read would not match
      const session = new LlamaChatSession({ contextSequence: main, chatWrapper: chatWrapper() })
      session.setChatHistory(toHistory(messages.slice(0, -1)))
      try {
        await session.preloadPrompt(last.content, { signal })
        return main.tokenMeter.usedInputTokens - read0
      } finally {
        session.dispose({ disposeSequence: false })
        onTiming?.(`read ahead ${(main.tokenMeter.usedInputTokens - read0).toLocaleString('en-US')} tok ${((performance.now() - t0) / 1000).toFixed(1)} s`)
      }
    },
    /** the answer, without control tags; onToken gets it as it is written (thought: thinking, never shown) */
    async chat(req: { messages: EngineMessage[]; maxTokens?: number; thoughtBudget: number; temperature?: number }, onToken: (text: string, thought?: boolean) => void, signal?: AbortSignal, onTiming?: (text: string) => void): Promise<string> {
      if (!main || !model) throw new Error('No model loaded')
      const last = req.messages.at(-1)
      if (!last || last.role !== 'user') throw new Error('Last message must be from the user')
      const t0 = performance.now(), read0 = main.tokenMeter.usedInputTokens
      let first: number | undefined, made = 0, text = ''
      const clean = streamCleaner((t) => onToken(t, true))
      const session = new LlamaChatSession({ contextSequence: main, chatWrapper: chatWrapper() })
      session.setChatHistory(toHistory(req.messages.slice(0, -1)))
      try {
        await session.prompt(last.content, {
          ...samplingFor(model.fileInfo.metadata.general.architecture),
          // a fixed answer wanted (who is who): colder than the family's sampling, so the same meeting names the same people each time
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          signal, stopOnAbortSignal: true, budgets: { thoughtTokens: req.thoughtBudget },
          ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
          onToken: (t) => { made += t.length; first ??= performance.now() },
          onTextChunk: (chunk) => { text += chunk; const out = clean.push(chunk); if (out) onToken(out) },
        })
        const rest = clean.end()
        if (rest) onToken(rest)
        return cleanAnswer(text)
      } finally {
        // the sequence stays: it holds what was just read
        session.dispose({ disposeSequence: false })
        const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`
        onTiming?.(`read ${(main.tokenMeter.usedInputTokens - read0).toLocaleString('en-US')} tok ${s((first ?? performance.now()) - t0)}, wrote ${made.toLocaleString('en-US')} tok ${s(performance.now() - (first ?? t0))}`)
      }
    },
  }
}
