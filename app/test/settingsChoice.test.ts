import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadSettings, saveAiChoice, updateSettings } from '../src/main/settings'

describe('the local AI choice in settings', () => {
  it('keeps the chosen model, then the choice to use Yogurt without AI', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'yogurt-settings-')), 'settings.json')
    updateSettings(file, { selectedModelId: 'gemma-4-e4b' })
    expect(loadSettings(file).selectedModelId).toBe('gemma-4-e4b')
    expect(loadSettings(file).withoutAi).toBeUndefined()
    updateSettings(file, { selectedModelId: undefined, withoutAi: true })
    expect(loadSettings(file).selectedModelId).toBeUndefined()
    expect(loadSettings(file).withoutAi).toBe(true)
  })

  it('choosing a model clears the without-AI choice', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'yogurt-settings-')), 'settings.json')
    updateSettings(file, { withoutAi: true })
    saveAiChoice(file, { modelId: 'gemma-4-e4b' })
    expect(loadSettings(file).selectedModelId).toBe('gemma-4-e4b')
    expect(loadSettings(file).withoutAi).toBeUndefined()
  })

  it('choosing to use Yogurt without AI clears the model', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'yogurt-settings-')), 'settings.json')
    updateSettings(file, { selectedModelId: 'gemma-4-e4b' })
    saveAiChoice(file, { withoutAi: true })
    expect(loadSettings(file).selectedModelId).toBeUndefined()
    expect(loadSettings(file).withoutAi).toBe(true)
  })
})
