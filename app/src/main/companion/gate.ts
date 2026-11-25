import { phoneCompanionOn } from '../../shared/companion'

/** Whether to start the companion at all: never while the flag is off; in fake mode only when a test asks for it */
export const companionWanted = (env: Record<string, string | undefined>, fake: boolean, platform: NodeJS.Platform = process.platform): boolean =>
  phoneCompanionOn(env, platform) && (!fake || env.YOGURT_FAKE_COMPANION === '1')
