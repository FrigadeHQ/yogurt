import { projectRepository, projectWebsite } from '../../../shared/project'
import type { UpdateStatus } from '../../../shared/types'

/** Top to bottom. The corner button sits below the last item. */
export const cornerRows = ['news', 'github', 'discord', 'shortcuts', 'feedback', 'help', 'settings', 'trash'] as const
export const cornerLinks = {
  news: projectWebsite + '/updates',
  github: projectRepository,
  discord: projectWebsite + '/discord',
  feedback: projectRepository + '/issues/new',
  help: projectWebsite + '/#questions',
}

export function restartState(status: UpdateStatus | undefined, recording: boolean) {
  if (status?.state !== 'ready') return 'hidden'
  return recording ? 'after-recording' : 'ready'
}

// Only published, stable versions identify a changelog release. Ignore build metadata.
function release(version?: string) { return version?.match(/^(\d+\.\d+\.\d+)(?:\+[\w.-]+)?$/)?.[1] }

export function newerRelease(candidate?: string, opened?: string | null) {
  const a = release(candidate), b = release(opened ?? undefined)
  return !!a && (!b || a.localeCompare(b, 'en', { numeric: true }) > 0)
}

export function knownRelease(status?: UpdateStatus) {
  return newerRelease(status?.next, status?.version) ? release(status?.next) : release(status?.version)
}
