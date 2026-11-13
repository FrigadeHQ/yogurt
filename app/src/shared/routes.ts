/** The renderer can navigate only within this workspace. */
export const isAppRoute = (route: unknown): route is string => typeof route === 'string' &&
  (['', '/meetings', '/chat', '/trash', '/settings', '/settings/recordings'].includes(route) || /^\/(?:note|chat|folder)\/[\w-]+$/.test(route))
