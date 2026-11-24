import {readFileSync} from 'node:fs'
import {afterEach,expect,it,vi} from 'vitest'
import {useState,type ReactElement,type ReactNode} from 'react'
import {Transcript} from '../src/renderer/src/components/Transcript'
import {Swap,SwapText} from '../src/renderer/src/components/Swap'
import {TranscriptionControl, TranscriptionNotice, transcriptionNotice, type TranscriptNotice} from '../src/renderer/src/components/Transcription'
import {renderToStaticMarkup} from 'react-dom/server'
import {stepUploadClock,uploadClock} from '../src/shared/audioUpload'

vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:vi.fn(),useRef:(current:unknown)=>({current}),useMemo:(fn:()=>unknown)=>fn(),useCallback:(fn:unknown)=>fn,useEffect:vi.fn(),useLayoutEffect:vi.fn()}))
vi.mock('../src/renderer/src/i18n',()=>({useLanguage(){}}))
vi.mock('../src/renderer/src/useLoadingState',()=>({useLoadingState:()=> 'ready'}))
afterEach(()=>vi.clearAllMocks())
function elements(node:ReactNode):ReactElement<any>[] {
 if(Array.isArray(node))return node.flatMap(elements)
 if(!node||typeof node!=='object'||!('props' in node))return []
 const el=node as ReactElement<any>
 return [el,...elements(el.props.children)]
}
function transcriptElements(processing: boolean, hasLines: boolean, replacing = false, notice?: TranscriptNotice) {
 const lines=hasLines?[{id:1,meetingId:'sample',track:'them',startMs:0,endMs:1000,text:'The draft is ready.'}]:[]
 const states:unknown[]=[
  undefined, [], lines, false, true, // transcript snapshot, replacement, rows, failure, loaded
  false, undefined, {}, // active wording draft, focus after removal, live words
  false, false, ['them'], // Find, earlier rows, playable tracks
 ]
 vi.mocked(useState).mockImplementation((initial?:unknown):[unknown,()=>void]=>[states.length?states.shift():typeof initial==='function'?initial():initial,()=>{}])
 return elements(Transcript({id:'sample',recording:false,processing,replacing,notice}))
}
const transcript = (processing: boolean, hasLines: boolean, replacing = false) =>
  transcriptElements(processing, hasLines, replacing).map(e => e.props.className)
it('shows the transcription placeholder only until the first text, and hides playback while working',()=>{
 expect(transcript(true,false)).toContain('transcription-placeholder')
 for(const replacing of [false,true]) {
  const working=transcript(true,true,replacing)
  expect(working).not.toContain('transcription-placeholder')
  expect(working).not.toContain('transcript-player-dock')
 }
 expect(transcript(false,true)).toContain('transcript-player-dock')
})

const rows = (notice: TranscriptNotice | undefined, hasLines = false, processing = false) =>
  transcriptElements(processing, hasLines, false, notice).filter(e => e.type === 'li')

it('puts a failed file and its working retry in one empty row', () => {
  const run = vi.fn()
  const list = rows(transcriptionNotice('error', run, false))
  expect(list).toHaveLength(1)
  expect(list[0].props['data-testid']).toBe('transcript-empty')
  const html = renderToStaticMarkup(list[0])
  expect(html).toContain('empty-tile')
  expect(html).toContain('couldn&#x27;t transcribe this file.')
  expect(html).toContain('>Transcribe</button>')
  expect(html).not.toContain('Nothing heard yet.')
  const view = elements(list[0]).find(e => e.type === TranscriptionNotice)!
  const retry = elements(TranscriptionNotice(view.props)).find(e => e.type === 'button')!
  expect(retry.props.className).toBe('workspace-button')
  retry.props.onClick()
  expect(run).toHaveBeenCalledOnce()
})

it('keeps the notice above retained lines and offers Continue transcription', () => {
  const list = rows(transcriptionNotice('stopped', () => {}, true), true)
  expect(list[0].props.className).toBe('transcription-notice-slot')
  expect(list[1].props['data-testid']).toBe('transcript-turn')
  const html = renderToStaticMarkup(list[0])
  expect(html).toContain('Transcription stopped.')
  expect(html).toContain('disabled=""')
  expect(html).toContain('>Continue transcription</button>')
  expect(html).not.toContain('empty-tile')
})

it('keeps the silent empty state even when a completed job has audio and no notice', () => {
  const list = rows(transcriptionNotice('done', () => {}, false))
  expect(list).toHaveLength(1)
  expect(renderToStaticMarkup(list[0])).toContain('Nothing heard yet.')
})

it.each([['waiting-model', 'Waiting for the speech model'], ['waiting-recording', 'Waiting for recording to stop']] as const)(
  'centres %s alone while waiting for the first line', (state, message) => {
    const list = rows(transcriptionNotice(state, () => {}, false), false, true)
    expect(list).toHaveLength(1)
    const html = renderToStaticMarkup(list[0])
    expect(html).toContain(message)
    expect(html).not.toMatch(/<button|Nothing heard yet|transcription-placeholder/)
  },
)

it('keeps the upload recovery action and alert in both presentations', () => {
  const notice: TranscriptNotice = { kind: 'upload', run: () => {} }
  for (const hasLines of [false, true]) {
    const first = rows(notice, hasLines)[0]
    const html = renderToStaticMarkup(first)
    expect(html).toContain('role="alert"')
    expect(html).toContain('>Upload a file</button>')
    expect(html.includes('empty-tile')).toBe(!hasLines)
  }
})
it('keeps the shared busy button box and label, without the extra inset edge',()=>{
 const css=readFileSync(new URL('../src/renderer/src/styles.css',import.meta.url),'utf8')
 const busy=css.match(/\.note-resume-action\[data-processing=true\] \{([^}]+)\}/)![1]
 expect(busy).not.toMatch(/border-color:|background:/)
 expect(busy).not.toMatch(/box-shadow|gradient/)
 for(const state of ['preparing','transcribing'] as const) {
  const control=TranscriptionControl({state,onStop:()=>{}})
  expect(control.props.className).toContain('note-resume-action')
  expect(control.props['data-processing']).toBe('true')
  expect(control.props['aria-busy']).toBe('true')
  const children=elements(control)
  expect(children.find(e=>e.type===SwapText)?.props.text).toBe(state==='preparing'?'Preparing audio…':'Transcribing…')
  expect(children.some(e=>e.props.className==='chat-step')).toBe(false)
  const icon=children.find(e=>e.type===Swap)!
  expect(elements(Swap(icon.props)).some(e=>e.props.className==='summary-stop-square')).toBe(true)
 }
})
it('steps minutes and hours without changing the chosen date, including midnight',()=>{
 const at=+new Date(2026,10,17,23,59)
 expect(new Date(stepUploadClock(at,1))).toEqual(new Date(2026,10,17,0,0))
 expect(new Date(stepUploadClock(at,60))).toEqual(new Date(2026,10,17,0,59))
 expect(new Date(stepUploadClock(+new Date(2026,10,17),-1))).toEqual(new Date(2026,10,17,23,59))
 expect(new Date(stepUploadClock(uploadClock('2:45 PM',at,'en')!,1))).toEqual(new Date(2026,10,17,14,46))
})
