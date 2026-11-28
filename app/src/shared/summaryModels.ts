export const SUMMARY_MODEL_IDS = ['gemma-4-e4b', 'gemma-4-26b-a4b'] as const
export type SummaryModelId = typeof SUMMARY_MODEL_IDS[number]
export type SummaryModelChoice = { id: SummaryModelId; name: string; bytes: number; downloaded: boolean }
