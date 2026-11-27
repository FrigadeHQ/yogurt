type Floating = { setAlwaysOnTop(on: boolean, level: 'floating'): void; setVisibleOnAllWorkspaces(on: boolean, o: { visibleOnFullScreen: boolean; skipTransformProcessType: boolean }): void }

/**
 * Keeps a small window (the widget, the "Take notes?" card) above other apps, full-screen calls included.
 * skipTransformProcessType: otherwise Electron turns the whole app into a menu-bar-only one and the Dock icon goes.
 */
export function floatOverFullScreen(w: Floating): void {
  w.setAlwaysOnTop(true, 'floating')
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
}

/**
 * The floating windows' type. A Mac: the widget and the Take notes card are non-activating panels, the stop card a plain window.
 * Windows and Linux have no panels: a tool window stays out of Alt+Tab and the taskbar; focusable: false keeps it from taking focus.
 * Linux (X11, XWayland on Wayland): some window managers still focus a tool window that refuses focus (Mango, #193), and
 * the keyboard then stays on Yogurt for every app. A window that never takes focus is a notification there, which they never focus.
 */
export const floatingType = (os: string, mac?: 'panel', focusable = true): 'panel' | 'toolbar' | 'notification' | undefined =>
  os === 'darwin' ? mac : os === 'linux' && !focusable ? 'notification' : 'toolbar'
