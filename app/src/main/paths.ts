// a default import, so plain Node (local recording checks) can load this file too
import electron from 'electron'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** One profile folder however Yogurt is started (dev, packaged): ~/Library/Application Support/Yogurt. YOGURT_USER_DATA uses a separate one (tests) */
export const userDataDir = (): string => process.env.YOGURT_USER_DATA ?? join(electron.app.getPath('appData'), 'Yogurt')

/**
 * Where the downloaded models live (5 to 12 GB): YOGURT_MODELS_DIR, else the folder the Windows installer asked for
 * (build/installer.nsh writes it to models-dir.txt, UTF-16 with a byte-order mark), else <profile>/models.
 * Settings, meetings and logs stay in the profile either way.
 */
export const modelsFolder = (): string => {
  const env = process.env.YOGURT_MODELS_DIR
  if (env && isAbsolute(env)) return env
  try {
    const raw = readFileSync(join(userDataDir(), 'models-dir.txt'))
    const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.subarray(2).toString('utf16le') : raw.toString('utf8')
    const chosen = text.trim()
    if (chosen && isAbsolute(chosen)) return chosen
  } catch { /* no folder chosen */ }
  return join(userDataDir(), 'models')
}

/** Test mode: stand-ins for everything that needs a model, the microphone or a calendar */
export const isFake = (): boolean => process.env.YOGURT_FAKE === '1'
