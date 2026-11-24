import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { isValidElement, type ReactElement, type ReactNode } from 'react'

const hooks = vi.hoisted(() => ({ values: [] as unknown[], refs: [] as { current: unknown }[], memos: [] as unknown[], effects: [] as { cleanup?: () => void }[], state: 0, ref: 0, memo: 0, effect: 0 }))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const i = hooks.state++
    if (!(i in hooks.values)) hooks.values[i] = typeof initial === 'function' ? initial() : initial
    return [hooks.values[i], (next: unknown) => { hooks.values[i] = typeof next === 'function' ? next(hooks.values[i]) : next }]
  },
  useRef: (initial: unknown) => hooks.refs[hooks.ref++] ?? (hooks.refs[hooks.ref - 1] = { current: initial }),
  useMemo: (make: () => unknown) => { const i = hooks.memo++; return hooks.memos[i] ?? (hooks.memos[i] = make()) },
  useEffect: () => {},
}))

const assignSpeaker = vi.fn()
beforeEach(() => {
  hooks.state = 0; hooks.ref = 0; hooks.memo = 0; hooks.effect = 0
  hooks.values = []; hooks.refs = []; hooks.memos = []; hooks.effects = []
  vi.clearAllMocks()
  vi.stubGlobal('window', { yogurt: { transcript: { assignSpeaker } } })
})
afterEach(() => vi.unstubAllGlobals())

const find = (node: ReactNode, id: string): ReactElement<Record<string, unknown>> | undefined => {
  if (Array.isArray(node)) return node.map(child => find(child, id)).find(Boolean)
  if (!isValidElement<Record<string, unknown>>(node)) return
  return node.props['data-testid'] === id ? node : find(node.props.children as ReactNode, id)
}
const line = { id: 7, meetingId: 'm1', track: 'them' as const, startMs: 1000, endMs: 2000, text: ' Als Lead Engineer bei Wunderlist half', speaker: null, speakerKey: null }
const voices = [{ name: 'Speaker 1', key: 'v26' }, { name: 'Speaker 2', key: 'v27' }]

async function render(o: { voices?: typeof voices } = {}) {
  hooks.state = 0; hooks.ref = 0; hooks.memo = 0; hooks.effect = 0
  const { WhoName } = await import('../src/renderer/src/components/Transcript')
  return WhoName({ meetingId: 'm1', line, voices: o.voices ?? voices }) as ReactNode
}

const kathLine = { ...line, id: 9, speaker: 'Katharina', speakerKey: 'v30' as const }

it('an Andere line offers the meeting’s speakers and assigns the line to the picked one', async () => {
  const tree = await render()
  const menu = find(tree, 'speaker-menu')
  expect(menu).toBeTruthy()
  // closed until clicked
  expect(find(tree, 'speaker-assign')).toBeUndefined()
  ;(menu!.props.onClick as () => void)()
  const opened = await render()
  const items: Array<ReactElement<Record<string, unknown>>> = []
  const collect = (node: ReactNode) => {
    if (Array.isArray(node)) return node.forEach(collect)
    if (!isValidElement<Record<string, unknown>>(node)) return
    if (node.props['data-testid'] === 'speaker-assign') items.push(node)
    collect(node.props.children as ReactNode)
  }
  collect(opened)
  expect(items.map(x => x.props.children)).toEqual(['Assign to Speaker 1', 'Assign to Speaker 2'])
  ;(items[1].props.onClick as () => void)()
  expect(assignSpeaker).toHaveBeenCalledWith('m1', 7, 'v27')
})

it('a meeting with no voices of its own shows a plain name instead of the assign buttons', async () => {
  const tree = await render({ voices: [] })
  expect(find(tree, 'speaker-menu')).toBeUndefined()
  const head = find(tree, 'transcript-who')
  expect(head).toBeTruthy()
  expect(head!.props.children).toBe('Them')
})

const stop = () => ({ stopPropagation: () => {} })

async function renderAssign(o: { voices?: Array<{ name: string; key: string }> } = {}) {
  hooks.state = 0; hooks.ref = 0; hooks.memo = 0; hooks.effect = 0
  const { LineAssign } = await import('../src/renderer/src/components/Transcript')
  const kath = { ...line, id: 9, speaker: 'Katharina', speakerKey: 'v30' }
  return LineAssign({ meetingId: 'm1', line: kath, voices: o.voices ?? [...voices, { name: 'Katharina', key: 'v30' }] }) as ReactNode
}

it('a line of a named voice offers the other voices and moves just that one line', async () => {
  const tree = await renderAssign()
  const menu = find(tree, 'line-assign-menu')
  expect(menu).toBeTruthy()
  expect(find(tree, 'line-assign-item')).toBeUndefined()
  ;(menu!.props.onClick as (e: { stopPropagation: () => void }) => void)(stop())
  // a state change shows on the next render (the hook mock, like the WhoName test)
  const opened = await renderAssign()
  const items: Array<ReactElement<Record<string, unknown>>> = []
  const collect = (node: ReactNode) => {
    if (Array.isArray(node)) return node.forEach(collect)
    if (!isValidElement<Record<string, unknown>>(node)) return
    if (node.props['data-testid'] === 'line-assign-item') items.push(node)
    collect(node.props.children as ReactNode)
  }
  collect(opened)
  // Katharina herself is not offered: assigning to her would be nothing
  expect(items.map(x => x.props.children)).toEqual(['Assign to Speaker 1', 'Assign to Speaker 2'])
  ;(items[1].props.onClick as (e: { stopPropagation: () => void }) => void)(stop())
  expect(assignSpeaker).toHaveBeenCalledWith('m1', 9, 'v27')
})

it('a voice alone in the meeting offers no per-line menu', async () => {
  const tree = await renderAssign({ voices: [{ name: 'Katharina', key: 'v30' }] })
  expect(find(tree, 'line-assign-menu')).toBeUndefined()
})
