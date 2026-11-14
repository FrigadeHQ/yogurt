/** sherpa-onnx-node 2.0.1 ships JSDoc types only (types.js), no .d.ts — this covers the surfaces the embed worker uses */
declare module 'sherpa-onnx-node' {
  export interface SpeakerEmbeddingModelConfig {
    model: string
    numThreads: number
    provider: string
    debug: number
  }

  export interface SpeakerEmbeddingExtractorConfig {
    modelConfig: SpeakerEmbeddingModelConfig
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
    compute(stream: OnlineStream, enableExternalBuffer?: boolean): Float32Array
  }
}
