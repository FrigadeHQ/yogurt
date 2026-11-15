import { pick, type CatalogModel, type Choice, type Hardware, type PickResult } from '@yogurt/picker'
import type { AiPlan, AiPlanChoice, AiPlanUnavailable } from '../shared/types'
import { hardwareLine } from './hardware'

/** what the picker found, in the plain shape the picker screens read */
const choice = (c: Choice): AiPlanChoice => ({
  modelId: c.model.id,
  name: c.model.name,
  ...(c.model.description ? { description: c.model.description } : {}),
  sizeGB: c.build.sizeGB,
  estMemoryGB: c.estMemoryGB,
  estTokPerSec: c.estTokPerSec,
  contextSize: c.contextSize,
  device: c.device,
  needsDiskGB: c.needsDiskGB,
})

const unavailable = (u: PickResult['unavailable'][number]): AiPlanUnavailable => ({
  modelId: u.model.id,
  name: u.model.name,
  ...(u.model.description ? { description: u.model.description } : {}),
  reason: u.reason,
  needsMemoryGB: u.needsMemoryGB,
})

/** What local AI can offer this computer, mapped from a picker result (no URLs or hashes reach the window). */
export function toAiPlan(hw: Hardware, result: PickResult): AiPlan {
  const recommended = result.recommended ? choice(result.recommended) : null
  return {
    hardware: hardwareLine(hw),
    recommended,
    ...(result.faster ? { faster: choice(result.faster) } : {}),
    ...(result.smarter ? { smarter: choice(result.smarter) } : {}),
    all: result.all.map(choice),
    unavailable: result.unavailable.map(unavailable),
    liteMode: result.liteMode,
    needsDiskGB: recommended?.needsDiskGB ?? 0,
  }
}

/** What local AI can offer this computer, before the person picks a model. */
export function aiPlan(hw: Hardware, models: CatalogModel[]): AiPlan {
  return toAiPlan(hw, pick(hw, models))
}
