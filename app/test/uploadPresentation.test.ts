import {readFileSync} from 'node:fs'
import {afterEach,expect,it,vi} from 'vitest'
import {useState,type ReactElement,type ReactNode} from 'react'
import {Transcript} from '../src/renderer/src/components/Transcript'
import {Swap,SwapText} from '../src/renderer/src/components/Swap'
import {TranscriptionControl} from '../src/renderer/src/components/Transcription'
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
function transcript(processing:boolean,hasLines:boolean,replacing=false) {
 const lines=hasLines?[{id:1,meetingId:'sample',track:'them',startMs:0,endMs:1000,text:'The draft is ready.'}]:[]
 const states:unknown[]=[[],lines,false,true,{},false,false,['them']]
 vi.mocked(useState).mockImplementation((initial?:unknown):[unknown,()=>void]=>[states.length?states.shift():typeof initial==='function'?initial():initial,()=>{}])
 return elements(Transcript({id:'sample',recording:false,processing,replacing})).map(e=>e.props.className)
}
it('shows the transcription placeholder only until the first text, and hides playback while working',()=>{
 expect(transcript(true,false)).toContain('transcription-placeholder')
 for(const replacing of [false,true]) {
  const working=transcript(true,true,replacing)
  expect(working).not.toContain('transcription-placeholder')
  expect(working).not.toContain('transcript-player-dock')
 }
 expect(transcript(false,true)).toContain('transcript-player-dock')
})
it('keeps the shared busy button box and label, without the extra inset edge',()=>{
 const css=readFileSync(new URL('../src/renderer/src/styles.css',import.meta.url),'utf8')
 const busy=css.match(/\.note-resume-action\[data-processing=true\] \{([^}]+)\}/)![1]
 expect(busy).not.toMatch(/border-color:|background:/)
 expect(busy).toContain('box-shadow:0 1px 2px #0000000A')
 expect(busy).not.toContain('inset')
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
