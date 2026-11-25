export const GRANOLA_CSV_BYTES = 128 * 1024 * 1024

export type GranolaMethod = 'connect' | 'csv' | 'key'

export type GranolaStatus = {
  source: GranolaMethod | null
  connected: boolean
  notice: string | null
  hasKey: boolean
  phase: 'idle' | 'connecting' | 'listing' | 'finding' | 'importing' | 'waiting'
  recent: { id: string; title: string }[]
  retryAt: number | null
  cancelled: boolean
  available: number | null
  result: { total: number; added: number; skipped: number; failures: { title: string; reason: string }[] } | null
  error: string | null
}
