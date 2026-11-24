import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { SourceCitationCard } from '../src/renderer/src/components/SourceCitation'
import { AUDIO_SPEAKER } from '../src/shared/audioUpload'
import type { LibrarySource } from '../src/shared/types'

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useId: () => 'card', useState: (value: unknown) => [value, vi.fn()], useRef: () => ({ current: null }), useEffect: vi.fn(), useLayoutEffect: vi.fn() }))
vi.mock('../src/renderer/src/motion', async original => ({ ...await original<typeof import('../src/renderer/src/motion')>(), useReducedMotion: () => true }))

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap(child => isValidElement(child)
    ? [child as ReactElement<Record<string, unknown>>, ...elements((child.props as { children?: ReactNode }).children)] : [])
}

it('opens each source at the supporting uploaded-audio line, including a zero timestamp', () => {
  const sentence = 'The export is limited to forty accounts.'
  const make = (n: number, atMs: number): LibrarySource => ({ n, meetingId: `meeting-${n}`, title: 'Release review', startedAt: 1, atMs: 300000,
    excerpt: `Audio: ${sentence}`, transcript: { speakers: [], lines: [{ text: sentence, startMs: atMs, track: 'them', speaker: AUDIO_SPEAKER }] } })
  const first = make(1, 90000), second = make(2, 0), onOpen = vi.fn()
  const card = SourceCitationCard({ source: first, additionalSources: [second], sentence, triggerId: null, open: true, animate: false, onOpen })
  const buttons = elements(card).filter(e => e.props['data-testid'] === 'citation-open')
  expect(buttons).toHaveLength(2)
  for (const button of buttons) (button.props.onClick as () => void)()
  expect(onOpen.mock.calls).toEqual([[sentence, first, 90000], [sentence, second, 0]])
})

it('checks historical quotes at their saved rows, including quotes that span rows', async () => {
  const { currentCitation } = await import('../src/main/library/citation')
  const { openStore } = await import('../src/main/store')
  const store = openStore(':memory:')
  try {
    const {id} = store.createMeeting({ title:'Plan', attendees:[], startedAt:1, endedAt:5000, app:null, eventId:null, state:'done' })
    const entry = (startMs:number,text:string) => ({ meetingId:id, track:'them' as const, speaker:'Jo', startMs, endMs:startMs+900, text })
    store.addSegments([entry(0,'Opening the meeting.'),entry(1000,'Ship the parcel. Separate decision.'),entry(2000,'Pack the blue'),entry(3000,'folder tomorrow.')])
    const original = store.segments(id)
    const cite = (excerpt:string,atMs:number): LibrarySource => ({n:1,meetingId:id,title:'Plan',startedAt:1,atMs,excerpt,transcript:{speakers:['Jo'],lines:original}})
    const single = cite('Ship the parcel.',1000), multi = cite('Pack the blue folder tomorrow.',2000)
    const update = (i:number,text:string) => store.changeTranscript(id,store.meeting(id)?.transcriptRevision ?? 0,{kind:'wording',id:original[i].id,expected:store.segments(id).find(r=>r.id===original[i].id)!.text,text})
    expect(update(0,'Opening corrected.').status).toBe('saved')
    expect(update(1,'Ship the parcel. Different decision.').status).toBe('saved')
    expect(currentCitation(store,single,'Ship the parcel.')).toMatchObject({excerpt:'Ship the parcel.',verifiedRow:original[1].id,context:{before:'Opening corrected.'}})
    expect(currentCitation(store,multi,'Pack the blue folder tomorrow.')).toMatchObject({excerpt:'Pack the blue folder tomorrow.',atMs:2000})
    update(2,'Pack the red')
    const changed = currentCitation(store,multi,'Pack the blue folder tomorrow.')
    expect(changed).toMatchObject({changed:'wording'})
    expect(changed.excerpt).toBeUndefined()
    expect(changed.verifiedRow).toBeUndefined()
    update(1,'Send the parcel.')
    expect(currentCitation(store,single,'Ship the parcel.')).toMatchObject({changed:'wording',currentText:'Send the parcel.',atMs:1000})
    store.changeTranscript(id,4,{kind:'remove',ids:[original[3].id]})
    expect(currentCitation(store,multi,'Pack the blue folder tomorrow.')).toMatchObject({changed:'removed'})
    expect(currentCitation(store,{...single,transcript:undefined},'Ship the parcel.').changed).toBe('unknown')
  } finally { store.close() }
})
