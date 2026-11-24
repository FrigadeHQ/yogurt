import { afterEach, expect, it } from 'vitest'
import { FINISH_SETUP_KINDS } from '../src/shared/onboarding'
import { LOCALES, setLanguage } from '../src/shared/i18n'
import { finishSetupReason } from '../src/renderer/src/permissionCopy'

afterEach(() => setLanguage('en'))

it('keeps translated explanations concise and on one line', () => {
  for (const { id } of LOCALES) {
    setLanguage(id)
    for (const kind of FINISH_SETUP_KINDS) {
      const text = finishSetupReason(kind)
      // Copy-length guard; rendered checks measure the 340px card with each localized button.
      const length = [...new Intl.Segmenter(id, { granularity: 'grapheme' }).segment(text)].length
      expect(text, `${id}/${kind}`).not.toMatch(/[\n\r]/)
      expect(length, `${id}/${kind}: ${text}`).toBeLessThanOrEqual(/^(ja|ko|zh)/.test(id) ? 20 : 45)
    }
  }
})
