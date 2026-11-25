import { afterEach, expect, it, vi } from 'vitest'
import { toasts } from '../src/renderer/src/components/TrashToast'
import { People } from '../src/renderer/src/components/People'
import type { Meeting } from '../src/shared/types'

// Exercise grouped row callbacks with original indices without a browser.
const hooks = vi.hoisted(() => ({ values: [] as any[], index: 0 }))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: any) => {
    const index = hooks.index++
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial
    return [hooks.values[index], (next: any) => { hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next }]
  },
  useRef: () => ({ current: null }), useId: () => 'people', useCallback: (fn: unknown) => fn, useEffect: () => {}, useLayoutEffect: () => {},
}))
vi.mock('../src/renderer/src/components/TrashToast', () => ({ toasts: { add: vi.fn(() => 'removed'), close: vi.fn() } }))
vi.mock('../src/renderer/src/motion', () => ({ usePopoverPresence: () => ({ value: 'keyboard', props: {} }) }))
vi.mock('../src/renderer/src/useNotePopover', () => ({ useNotePopover: () => {} }))
function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]
}
const attendees = [{ name: 'Attendee One', email: 'one@zeta.example' }, { name: 'Attendee Two', email: 'two@alpha.example' }, { name: 'Self', email: 'self@zeta.example' }]
const meeting = { id: 'note', attendees, startedAt: 1, ownEmail: 'self@zeta.example' } as Meeting
function setup(m: Meeting = meeting) {
  const renameAttendee = vi.fn().mockResolvedValue(true), changeAttendee = vi.fn().mockResolvedValue(true)
  vi.stubGlobal('window', { yogurt: { meetings: { renameAttendee, changeAttendee } } })
  hooks.values = [false, 'Self']; hooks.index = 0
  const root = People({ m }) as any
  const element = root.props.children[1]
  hooks.values = []; hooks.index = 0
  const close = vi.fn()
  const render = () => { hooks.index = 0; return element.type({ ...element.props, onClose: close }) }
  return { render, renameAttendee, changeAttendee, close }
}
afterEach(() => vi.unstubAllGlobals())
it('renames and removes the original attendee after company sorting, keeping self uneditable', async () => {
  const { render, renameAttendee, changeAttendee } = setup()
  const rows = nodes(render()).filter(n => n.type?.name === 'Row')
  expect(rows.map(r => r.props.person.name)).toEqual(['Attendee Two', 'Self', 'Attendee One'])
  expect(rows[1].props.mine).toBe(true)
  expect(rows[1].props.onRemove).toBeUndefined()
  expect(rows[1].props.onEdit).toBeUndefined()
  const editor = () => nodes(render()).find(n => n.type?.name === 'AttendeeEditor')
  rows[0].props.onEdit()
  expect(editor().props.person).toBe(attendees[1])
  await editor().props.onSave({ name: 'Updated attendee', email: 'new@alpha.example' })
  expect(renameAttendee).toHaveBeenCalledWith('note', 1, 'Updated attendee', attendees[1], 'new@alpha.example')
  expect(editor()).toBeUndefined()
  await rows[0].props.onRemove()
  expect(editor()).toBeUndefined()
  expect(changeAttendee).toHaveBeenCalledWith('note', 'remove', attendees[1], 1)
  const toast = vi.mocked(toasts.add).mock.lastCall![0]
  expect(toast.actionProps?.children).toBe('Undo')
  await toast.actionProps!.onClick!({} as never)
  expect(changeAttendee).toHaveBeenLastCalledWith('note', 'add', attendees[1], 1)
  expect(toasts.close).toHaveBeenCalledWith('removed')
})
it('keeps the row available for retry after a failed removal', async () => {
  const { render, changeAttendee } = setup()
  changeAttendee.mockResolvedValue(false)
  const row = nodes(render()).find(n => n.type?.name === 'Row' && !n.props.mine)
  const start = hooks.index
  const buttons = () => { hooks.index = start; return nodes(row.type(row.props)).filter(n => n.type === 'button') }
  const pending = buttons().find(n => n.props['data-testid'] === 'people-remove').props.onClick()
  expect(buttons().every(b => b.props.disabled)).toBe(true)
  await pending
  expect(buttons().some(b => b.props.disabled)).toBe(false)
  expect(vi.mocked(toasts.add).mock.lastCall![0]).toEqual({ title: "Yogurt couldn't make that change. Try again." })
})
it('retains keyboard entry for adding attendees and Escape dismissal', async () => {
  const { render, changeAttendee, close } = setup()
  const byId = (id: string) => nodes(render()).find(n => n.props?.['data-testid'] === id)
  byId('people-add-open').props.onClick()
  byId('people-add').props.onChange({ target: { value: 'Additional attendee attendee@beta.example' } })
  byId('people-add').props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: false }, preventDefault: vi.fn() })
  await Promise.resolve(); await Promise.resolve()
  expect(changeAttendee).toHaveBeenCalledWith('note', 'add', { name: 'Additional attendee', email: 'attendee@beta.example' }, undefined)
  expect(byId('people-add').props.value).toBe('')
  render().props.onKeyDown({ key: 'Escape', nativeEvent: {}, preventDefault: vi.fn(), stopPropagation: vi.fn() })
  expect(close).toHaveBeenCalledOnce()
})
it('groups the self row by the saved event address, even with no attendee of the same name', () => {
  const m = { ...meeting, ownEmail: 'self@alpha.example', attendees: attendees.slice(0, 2) }
  const { render } = setup(m)
  const groups = nodes(render()).filter(n => n.type === 'section')
  const alpha = groups.find(g => g.props['aria-label'] === 'Alpha')
  const rows = nodes(alpha).filter(n => n.type?.name === 'Row')
  expect(rows.map(r => r.props.person.email)).toEqual(['self@alpha.example', 'two@alpha.example'])
  expect(rows[0].props.mine).toBe(true)
  expect(rows[0].props.onEdit).toBeUndefined(); expect(rows[0].props.onRemove).toBeUndefined()
})
it('does not invent the self address from a matching name and retains another person with the same name', () => {
  const { render } = setup({ ...meeting, ownEmail: undefined })
  expect(nodes(render()).find(n => n.type?.name === 'Row' && n.props.mine).props.person.email).toBeNull()
  const other = setup({ ...meeting, ownEmail: 'mine@alpha.example' })
  expect(nodes(other.render()).filter(n => n.type?.name === 'Row' && n.props.person.name === 'Self')).toHaveLength(2)
})

it.each([null, 'one@zeta.example'])('opens a dedicated form from the name or pencil for %s', email => {
  const { render, renameAttendee, changeAttendee } = setup({ ...meeting, attendees: [{ ...attendees[0], email }] })
  const row = nodes(render()).find(n => n.type?.name === 'Row' && !n.props.mine)
  const contents = nodes(row.type(row.props))
  const buttons = contents.filter(n => n.type === 'button')
  expect(buttons.map(n => n.props['data-testid'])).toEqual(['people-name', 'people-edit', 'people-remove'])
  const [name, pencil, trash] = buttons
  expect(trash.props).toMatchObject({ 'aria-label': 'Remove from meeting', title: 'Remove from meeting' })
  expect(contents.some(n => n.type === 'input')).toBe(false)
  for (const opener of [name, pencil]) {
    opener.props.onClick()
    const detail = nodes(render())
    expect(detail.some(n => n.props['data-testid'] === 'people-list')).toBe(false)
    const editor = detail.find(n => n.type?.name === 'AttendeeEditor')
    const form = editor.type(editor.props), fields = nodes(form).filter(n => n.type === 'input')
    expect(nodes(form).find(n => n.type === 'h3').props.children).toBe('Edit attendee')
    expect(nodes(form).filter(n => n.type === 'label').map(n => n.props.children[0])).toEqual(['Name', 'Email'])
    expect(fields.map(n => n.props.defaultValue)).toEqual(['Attendee One', email ?? ''])
    expect(fields[1].props.placeholder).toBe('Add email')
    const actions = nodes(form).filter(n => n.type === 'button')
    expect(actions.map(n => n.props['aria-label'] || n.props.children)).toEqual(['Cancel', 'Save'])
    expect(actions[1].props).toMatchObject({ type: 'submit', className: expect.stringContaining('primary') })
    const invalid = { name: 'email', focus: vi.fn() }
    form.props.onSubmit({ currentTarget: { querySelector: () => invalid }, preventDefault: vi.fn() })
    expect(invalid.focus).toHaveBeenCalledOnce()
    expect(nodes(render()).some(n => n.type?.name === 'AttendeeEditor')).toBe(true)
    actions[0].props.onClick()
    expect(nodes(render()).some(n => n.props['data-testid'] === 'people-list')).toBe(true)
  }
  expect(renameAttendee).not.toHaveBeenCalled()
  expect(changeAttendee).not.toHaveBeenCalled()
})
