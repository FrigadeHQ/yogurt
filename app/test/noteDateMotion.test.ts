import { afterEach, expect, it, vi } from 'vitest'
import { NoteDateBody } from '../src/renderer/src/components/NoteDate'

afterEach(() => vi.unstubAllGlobals())
function setup(reduced = false, duration = '180ms') {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: reduced }) })
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (key: string) => key === '--note-date-ms' ? duration : 'cubic-bezier(.22,1,.36,1)' }))
  const animations: { cancel: ReturnType<typeof vi.fn>; finished: Promise<void>; finish: () => void }[] = []
  const animate = vi.fn(() => {
    let finish!: () => void
    const animation = { cancel: vi.fn(), finished: new Promise<void>(resolve => { finish = resolve }), finish: () => finish() }
    animations.push(animation)
    return animation
  })
  const target = { removeAttribute: vi.fn() }
  const copy = { inert: false, setAttribute: vi.fn(), querySelectorAll: () => [target], classList: { add: vi.fn() }, remove: vi.fn(), animate }
  const body = { cloneNode: () => copy, getBoundingClientRect: () => ({ height: 180 }), animate }
  const shell = { getBoundingClientRect: () => ({ height: 320 }), append: vi.fn(), animate }
  const component = new NoteDateBody({ view: 'linked/details/granted', children: null })
  // DOM geometry and Web Animations are supplied directly; no browser runner is required.
  Object.assign((component as any).body, { current: body })
  Object.assign((component as any).shell, { current: shell })
  return { component, body, shell, copy, target, animate, animations }
}
it('cross-fades over the measured old/new heights with the shared 180 ms token, then removes the inert copy', async () => {
  const { component, copy, target, shell, animate, animations } = setup()
  const snapshot = component.getSnapshotBeforeUpdate({ view: 'unlinked/picker/granted', children: null })!
  expect(snapshot.height).toBe(320)
  expect(copy.inert).toBe(true)
  expect(copy.setAttribute).toHaveBeenCalledWith('aria-hidden', 'true')
  for (const attr of ['id', 'data-testid', 'autofocus']) expect(target.removeAttribute).toHaveBeenCalledWith(attr)
  component.componentDidUpdate(null, null, snapshot)
  expect(shell.append).toHaveBeenCalledWith(copy)
  const timing = { duration: 180, easing: 'cubic-bezier(.22,1,.36,1)' }
  expect(animate).toHaveBeenNthCalledWith(1, [{ height: '320px' }, { height: '180px' }], timing)
  expect(animate).toHaveBeenNthCalledWith(2, [{ opacity: 0 }, { opacity: 1 }], timing)
  expect(animate).toHaveBeenNthCalledWith(3, [{ opacity: 1 }, { opacity: 0 }], timing)
  animations.forEach(a => a.finish())
  await Promise.all(animations.map(a => a.finished)); await Promise.resolve()
  expect(copy.remove).toHaveBeenCalledOnce()
  expect(animations.every(a => a.cancel.mock.calls.length === 1)).toBe(true)
})
it('cancels an interrupted transition and cleans up on unmount', () => {
  const { component, animations, copy } = setup()
  const snapshot = component.getSnapshotBeforeUpdate({ view: 'unlinked/picker/granted', children: null })!
  component.componentDidUpdate(null, null, snapshot)
  component.componentDidUpdate(null, null, snapshot)
  expect(animations.slice(0, 3).every(a => a.cancel.mock.calls.length === 1)).toBe(true)
  component.componentWillUnmount()
  expect(copy.remove).toHaveBeenCalledTimes(2)
  expect(animations.every(a => a.cancel.mock.calls.length === 1)).toBe(true)
})
it('skips copies and motion for unchanged views, reduced motion and static review frames', () => {
  for (const [reduced, duration] of [[true, '180ms'], [false, '0ms']] as const) {
    const { component, animate } = setup(reduced, duration)
    expect(component.getSnapshotBeforeUpdate({ view: 'unlinked/details/granted', children: null })).toBeNull()
    expect(animate).not.toHaveBeenCalled()
  }
  const { component } = setup()
  expect(component.getSnapshotBeforeUpdate(component.props)).toBeNull()
})
