import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * nemo-speech (speaker diarization, built by scripts/native.sh) in resources/bin with the other helpers.
 * Undefined when it is not there (a dev build before native.sh ran): the meeting is marked diarized with
 * the reason instead.
 */
export function nemoSpeechPath(): string | undefined {
  const file = process.platform === 'win32' ? 'nemo-speech.exe' : 'nemo-speech'
  const candidates = [
    process.resourcesPath && join(process.resourcesPath, 'bin', file),
    join(__dirname, '../../resources/bin', file),
    join(__dirname, '../../../resources/bin', file),
    join(__dirname, '../../../../resources/bin', file),
    join(__dirname, '../../../../../resources/bin', file),
  ].filter((x): x is string => !!x)
  return candidates.find((c) => existsSync(c))
}
