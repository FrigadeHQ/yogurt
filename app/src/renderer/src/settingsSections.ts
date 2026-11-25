import { settingsSections } from '../../shared/routes'
import { t } from '../../shared/i18n'
import { AudioLines, Bell, Download, Link, SlidersHorizontal } from './components/Icons'

export const sections = {
  general: { label: () => t('General'), icon: SlidersHorizontal },
  notifications: { label: () => t('Notifications'), icon: Bell },
  recording: { label: () => t('Recording & notes'), icon: AudioLines },
  connections: { label: () => t('Connections'), icon: Link },
  storage: { label: () => t('Storage & backup'), icon: Download },
}

export function sectionFor(focus?: string) {
  if (focus === 'calendar') return 'connections'
  if (focus === 'recordings' || focus === 'import') return 'storage'
  if (focus === 'notes-model') return 'recording'
  return settingsSections.find(id => id === focus) ?? 'general'
}
