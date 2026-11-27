/** sherpa-onnx-node 2.0.1 ships JSDoc types only (types.js), no .d.ts — this covers the surfaces the embed worker uses */
declare module 'sherpa-onnx-node' {
  export interface SpeakerEmbeddingExtractorConfig {
    model: string
    numThreads: number
    provider: string
    debug: number
  }

  export class OnlineStream {
    acceptWaveform(waveform: { samples: Float32Array; sampleRate: number }): void
    inputFinished(): void
  }

  export class SpeakerEmbeddingExtractor {
    constructor(config: SpeakerEmbeddingExtractorConfig)
    /** the embedding dimension (192 for CAM++); a property, not a method */
    readonly dim: number
    createStream(): OnlineStream
    isReady(stream: OnlineStream): boolean
    /** false: Electron's utility process refuses the external buffers onnxruntime would hand back */
    compute(stream: OnlineStream, enableExternalBuffer?: boolean): Float32Array
  }

  /** the package is CommonJS: its whole exports object is the default import */
  const sherpa: { SpeakerEmbeddingExtractor: typeof SpeakerEmbeddingExtractor }
  export default sherpa
}
