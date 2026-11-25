export const settingsSections = ['general', 'notifications', 'recording', 'connections', 'storage'] as const
export type SettingsSection = typeof settingsSections[number]
export const settingsRoute = (section: SettingsSection) => section === 'general' ? '/settings' : '/settings/' + section
export const isSettingsRoute = (route: string) => route === '/settings' || route.startsWith('/settings/')

/** The renderer can navigate only within this workspace. */
export const isAppRoute = (route: unknown): route is string => typeof route === 'string' &&
  (['', '/meetings', '/chat', '/trash', '/settings', '/settings/import', '/settings/calendar', '/settings/recordings', '/settings/notes-model'].includes(route) || settingsSections.some(section => settingsRoute(section) === route) ||
    /^\/(?:note|chat|folder)\/[\w-]+$/.test(route))
