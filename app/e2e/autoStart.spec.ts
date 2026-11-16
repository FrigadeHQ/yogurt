import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
const zoom = { bundleId: 'us.zoom.xos', name: 'zoom.us' }

async function launch(settings?: object) {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  if (settings) writeFileSync(join(userData, 'settings.json'), JSON.stringify(settings))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page, userData }
}
type Reading = { micApps: { bundleId: string; name: string }[]; events: unknown[] }
const fake = <T = unknown>(app: ElectronApplication, fn: string, arg?: unknown) =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>
const signals = (app: ElectronApplication, r: Reading) => fake(app, 'signals', r)
const cards = (app: ElectronApplication) => app.windows().filter((w) => !w.isClosed() && w.url().includes('#prompt')).length
const widgetView = async (app: ElectronApplication) => (await fake<{ view: { kind: string } | null }>(app, 'widget')).view
const presented = async (app: ElectronApplication) => (await fake<{ presented: number }>(app, 'main')).presented
const event = () => {
  const start = Date.now() - 60_000
  return { id: 'ev1', title: 'Design review', start, end: start + 30 * 60_000, attendees: [], url: 'https://zoom.us/j/1' }
}

test('off by default; the Settings switch saves it', async () => {
  const { app, page, userData } = await launch()
  try {
    await page.getByTestId('settings-open').click()
    const toggle = page.getByTestId('autostart-toggle')
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).startWhenCallStarts).toBe(true)
  } finally { await app.close() }
})

test('turned on: a call starts the recording with no card and without taking focus, and its end stops it', async () => {
  const { app, userData } = await launch({ startWhenCallStarts: true })
  try {
    const before = await presented(app)
    await signals(app, { micApps: [zoom], events: [event()] })
    await expect.poll(() => widgetView(app)).toMatchObject({ kind: 'recording' })
    expect(cards(app)).toBe(0)
    expect(await presented(app)).toBe(before)
    await signals(app, { micApps: [], events: [event()] })
    await fake(app, 'advance', 11_000)
    await expect.poll(() => fake(app, 'notice')).toEqual({ title: 'Call ended. Recording stopped.', body: 'Design review' })
    const logs = readFileSync(join(userData, 'logs/main.log'), 'utf8')
    expect(logs).toContain('CALL auto-start app=Zoom')
    expect(logs).toMatch(/CALL gone meeting=\S+ app=Zoom/)
  } finally { await app.close() }
})

test('rejoining a call whose recording ended: the card offers Resume, and goes away with the call', async () => {
  const { app } = await launch({ startWhenCallStarts: true })
  try {
    await signals(app, { micApps: [zoom], events: [event()] })
    await expect.poll(() => widgetView(app)).toMatchObject({ kind: 'recording' })
    await signals(app, { micApps: [], events: [event()] })
    await fake(app, 'advance', 11_000)
    await expect.poll(() => fake(app, 'notice')).toMatchObject({ title: 'Call ended. Recording stopped.' })
    // a look with no call between the stop and the rejoin
    await signals(app, { micApps: [], events: [event()] })
    // the finished note keeps its guarded Resume: nothing records by itself, the card asks
    await signals(app, { micApps: [zoom], events: [event()] })
    await expect.poll(() => cards(app)).toBe(1)
    expect((await widgetView(app))?.kind).not.toBe('recording')
    await signals(app, { micApps: [], events: [event()] })
    await expect.poll(() => cards(app)).toBe(0)
  } finally { await app.close() }
})
