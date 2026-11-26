import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'

/** whisper.cpp's model files start with "ggml" as a little-endian number; GGUF is not one whisper-server loads */
const GGML_MAGIC = 0x67676d6c

/**
 * A speech model file of the person's own (Settings → Transcription → Choose a file…). Not in the catalog, so there is
 * no hash to check: it has to be a file Yogurt can read whose header is a Whisper model's (whisper.cpp's ggml .bin).
 * Cheap enough to run each time a meeting is about to be transcribed with it.
 */
export function checkSpeechFile(path: string): { ok: true; bytes: number } | { ok: false; error: 'unreadable' | 'not-whisper' } {
  // a regular file before it is opened: opening a named pipe would wait for a writer
  let bytes: number
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return { ok: false, error: 'unreadable' }
    bytes = stat.size
  } catch { return { ok: false, error: 'unreadable' } }
  let fd: number
  try { fd = openSync(path, 'r') } catch { return { ok: false, error: 'unreadable' } }
  try {
    // the magic, then the hparams: n_vocab, n_audio_ctx, n_audio_state, n_audio_head, n_audio_layer, n_text_ctx,
    // n_text_state, n_text_head, n_text_layer, n_mels (int32 each)
    const head = Buffer.alloc(44)
    if (readSync(fd, head, 0, head.length, 0) < head.length) return { ok: false, error: 'not-whisper' }
    const magic = head.readUInt32LE(0), audioCtx = head.readInt32LE(8), mels = head.readInt32LE(40)
    // every Whisper model hears 30 s windows (1500 audio positions), with 80 mel bands, or 128 from large-v3 on
    if (magic !== GGML_MAGIC || audioCtx !== 1500 || (mels !== 80 && mels !== 128)) return { ok: false, error: 'not-whisper' }
    return { ok: true, bytes }
  } catch { return { ok: false, error: 'unreadable' } } finally { closeSync(fd) }
}

/** the path is in this folder (links followed): Yogurt's own files there are its to remove, nothing outside it is */
export function insideDir(path: string, dir: string) {
  const real = (p: string) => { try { return realpathSync(p) } catch { return p } }
  const rel = relative(real(dir), real(path))
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}
