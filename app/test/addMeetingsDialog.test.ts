import { afterEach, expect, it, vi } from 'vitest'
import { isValidElement, type ReactNode, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AddMeetingsDialog } from '../src/renderer/src/components/AddMeetingsDialog'
import type { Folder, FolderMeetingChoice } from '../src/shared/types'

const hooks = vi.hoisted(() => ({ values: [] as unknown[], i: 0, load: () => {} }))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState(initial: unknown) {
    const i = hooks.i++
    if (!(i in hooks.values)) hooks.values[i] = initial
    return [hooks.values[i], (v: unknown) => { hooks.values[i] = typeof v === 'function' ? v(hooks.values[i]) : v }]
  },
  useRef(initial: unknown) { const i = hooks.i++; return hooks.values[i] ??= { current: initial } },
  useMemo: (read: () => unknown) => read(),
  useEffect: (load: () => void) => { hooks.load = load },
}))
type Element = ReactElement<Record<string, unknown>>
function controls(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(controls)
  return isValidElement<Record<string, unknown>>(node) ? [node, ...controls(node.props.children as ReactNode)] : []
}
const folder: Folder = { id: 'f', name: 'Reviews', color: 'violet', icon: 'folder', createdAt: 0, count: 0 }
const render = () => { hooks.i = 0; return AddMeetingsDialog({ folder, onDone: vi.fn() }) }
const change = (el: Element, target: object) => (el.props.onChange as (e: { target: object }) => void)({ target })
afterEach(() => { vi.unstubAllGlobals(); hooks.values = [] })

it('keeps selections across searches and a failed save, and skips meetings already filed', async () => {
  let rows: FolderMeetingChoice[] = []
  const addMany = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  const onChange = () => () => {}
  vi.stubGlobal('window', { yogurt: { folders: { meetingChoices: async () => rows, addMany, onChange }, meetings: { onChange } } })
  const choices = () => controls(render()).filter(el => el.props.type === 'checkbox')
  const search = () => controls(render()).find(el => el.props['data-dialog-focus'])!
  const confirm = () => controls(render()).find(el => el.type === 'button' && el.props.className === 'modal-button primary')!
  const refresh = async () => { render(); hooks.load(); await Promise.resolve() }
  const save = async () => { (confirm().props.onClick as () => void)(); await Promise.resolve() }
  await refresh()
  expect(choices()).toHaveLength(0)
  expect(confirm().props.disabled).toBe(true)
  rows = [{ id: '0', title: 'A'.repeat(200), startedAt: 0, inFolder: true }]
  await refresh()
  expect(choices()[0].props).toMatchObject({ checked: true, disabled: true, tabIndex: -1 })
  expect(renderToStaticMarkup(controls(render()).find(el => el.props.className === 'folder-meeting-choice settings-calendar-choice')!.props.children as ReactNode)).toContain(rows[0].title)
  rows.push(...Array.from({ length: 199 }, (_, i) => ({ id: String(i + 1), title: 'Review ' + (i + 1), startedAt: i, inFolder: false })))
  await refresh()
  expect(choices()).toHaveLength(200)
  expect(choices().filter(el => el.props.tabIndex === 0)).toHaveLength(1)
  change(choices()[1], { checked: true })
  change(search(), { value: '  REVIEW 199  ' })
  expect(choices()).toHaveLength(1)
  change(choices()[0], { checked: true })
  expect(confirm().props.children).toBe('Add 2 meetings to folder')
  await save()
  expect(controls(render()).some(el => el.props.role === 'alert')).toBe(true)
  expect(confirm().props.disabled).toBe(false)
  await save()
  expect(addMany).toHaveBeenCalledTimes(2)
  expect(addMany).toHaveBeenLastCalledWith('f', ['1', '199'])
  expect(render().props.closing).toBe(true)
})
