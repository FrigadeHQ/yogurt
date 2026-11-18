// a default import, so plain Node (local recording checks) can load this file too
import electron from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
// a default import, so plain Node (local recording checks) can load this file too

/** One profile folder however Yogurt is started (dev, packaged): ~/Library/Application Support/Yogurt. YOGURT_USER_DATA uses a separate one (tests) */
export const userDataDir = (): string => process.env.YOGURT_USER_DATA ?? join(electron.app.getPath('appData'), 'Yogurt')
const modelsPointer = (): string => join(userDataDir(), 'models-dir.txt')

/** Where the downloaded models live: YOGURT_MODELS_DIR, else the folder the person chose, else <data>/models */
export const modelsFolder = (): string => {
  const env = process.env.YOGURT_MODELS_DIR
  if (env && isAbsolute(env)) return env
  try {
    const chosen = readFileSync(modelsPointer(), 'utf8').trim()
    if (chosen && isAbsolute(chosen)) return chosen
  } catch { /* no choice saved yet */ }
  return join(userDataDir(), 'models')
}

/** True once there is nothing left to ask: a saved choice, an env override, or models already on disk (existing installs) */
export const hasModelsChoice = (): boolean =>
  !!process.env.YOGURT_MODELS_DIR || existsSync(modelsPointer()) || existsSync(join(userDataDir(), 'models'))

export const saveModelsFolder = (dir: string): void => {
  mkdirSync(userDataDir(), { recursive: true })
  writeFileSync(modelsPointer(), dir)
}

/** Test mode: stand-ins for everything that needs a model, the microphone or a calendar */
export const isFake = (): boolean => process.env.YOGURT_FAKE === '1'
