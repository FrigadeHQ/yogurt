import { isNotificationEvent } from './notificationDelivery'

export const settingsSections = ['general', 'meetings', 'notes', 'notifications', 'connections', 'storage'] as const
export type SettingsSection = typeof settingsSections[number]
export const settingsRoute = (section: SettingsSection) => section === 'general' ? '/settings' : '/settings/' + section

/** The renderer can navigate only within this workspace. */
export const isAppRoute = (route: unknown): route is string => typeof route === 'string' &&
  (['', '/meetings', '/chat', '/trash', '/settings', '/settings/calendar', '/settings/recordings', '/settings/notes-model'].includes(route) || settingsSections.some(section => settingsRoute(section) === route) ||
    (route.startsWith('/settings/notifications/') && isNotificationEvent(route.slice('/settings/notifications/'.length))) || /^\/(?:note|chat|folder)\/[\w-]+$/.test(route))
