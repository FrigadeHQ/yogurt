import {useState,useEffect,useRef,type ReactNode,type ReactElement} from 'react'
import {afterEach,expect,it,vi} from 'vitest'
import {CalendarLinkForm} from '../src/renderer/src/components/CalendarLinkForm'
import {CalendarSettings} from '../src/renderer/src/components/CalendarSettings'
import {capabilities} from '../src/shared/platform'
import {calendarAddress} from '../src/shared/calendarLink'
import {LOCALES,setLanguage,t} from '../src/shared/i18n'

vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:vi.fn(),useEffect:vi.fn(),useRef:vi.fn(),useId:()=> 'calendar-address',useCallback:(fn:unknown)=>fn}))
afterEach(()=>{vi.clearAllMocks();vi.unstubAllGlobals();setLanguage('en')})
const walk=(node:ReactNode):ReactElement<any>[]=>Array.isArray(node)?node.flatMap(walk):node&&typeof node==='object'&&'props' in node?[node as ReactElement<any>,...walk((node as ReactElement<any>).props.children)]:[]
function harness(render:()=>ReactNode) {
 const states:unknown[]=[],refs:{current:unknown}[]=[],effects:{deps?:readonly unknown[];cleanup?:()=>void}[]=[]
 const focus=vi.fn();let tree:ReactNode
 const run=()=>{
  let state=0,ref=0
  vi.mocked(useState).mockImplementation((initial?:unknown):[unknown,(value:unknown)=>void]=>{const i=state++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return[states[i],v=>{states[i]=typeof v==='function'?v(states[i]):v}]})
  vi.mocked(useRef).mockImplementation(initial=>refs[ref++]??={current:initial})
  vi.mocked(useEffect).mockClear();tree=render()
  for(const el of walk(tree))if(el.props.ref)el.props.ref.current={focus}
  vi.mocked(useEffect).mock.calls.forEach(([effect,deps],i)=>{const old=effects[i];if(!old||!deps||deps.some((v,j)=>!Object.is(v,old.deps?.[j]))){old?.cleanup?.();effects[i]={deps,cleanup:effect()||undefined}}})
 }
 run()
 return {run,focus,get:(id:string)=>walk(tree).find(e=>e.props['data-testid']===id)!,type:(type:unknown)=>walk(tree).find(e=>e.type===type)!,all:()=>walk(tree)}
}
it.each(['', 'not a calendar', 'ftp://example.com/calendar.ics', 'javascript:alert(1)'])('does not submit an invalid calendar address %j',async url=>{
 const addLink=vi.fn();vi.stubGlobal('window',{yogurt:{calendar:{addLink}}})
 const h=harness(()=>CalendarLinkForm({only:'other',onConnected:vi.fn()}))
 h.get('calendar-link-input').props.onChange({target:{value:url}});h.run()
 expect(h.get('calendar-link-connect').props.disabled).toBe(true)
 h.get('calendar-link-input').props.onBlur({relatedTarget:null});h.run()
 expect(!!h.get('calendar-link-error')).toBe(!!url)
 expect(h.get('calendar-link-input').props['aria-invalid']).toBe(url?true:undefined)
 await h.get('calendar-link-form').props.onSubmit({preventDefault(){}})
 expect(addLink).not.toHaveBeenCalled()
})
it('does not move a button under the pointer by adding an error while focus moves to it',()=>{
 const h=harness(()=>CalendarLinkForm({only:'other',onConnected:vi.fn(),onCancel:vi.fn()}))
 h.get('calendar-link-input').props.onChange({target:{value:'invalid'}});h.run()
 h.get('calendar-link-input').props.onBlur({relatedTarget:{tagName:'BUTTON'}});h.run()
 expect(h.get('calendar-link-error')).toBeUndefined()
 h.get('calendar-link-input').props.onBlur({relatedTarget:null});h.run()
 expect(h.get('calendar-link-error')).toBeDefined()
})
it('keeps validation identical to main, including subscription links and the local test server',()=>{
 for(const url of ['https://calendar.example/feed?token=sample','webcal://calendar.example/feed','webcals://calendar.example/feed','http://127.0.0.1/calendar.ics'])expect(calendarAddress(url)).not.toBeNull()
 expect(calendarAddress('http://calendar.example/feed')).toBeNull()
})
it('labels the address and collapses without discarding a draft on Cancel or Escape',()=>{
 const cancel=vi.fn(),h=harness(()=>CalendarLinkForm({only:'other',autoFocus:true,onConnected:vi.fn(),onCancel:cancel}))
 expect(h.focus).toHaveBeenCalledWith({preventScroll:true})
 expect(h.all().find(e=>e.type==='label')!.props.htmlFor).toBe(h.get('calendar-link-input').props.id)
 h.get('calendar-link-input').props.onChange({target:{value:'https://calendar.example/private'}});h.run()
 h.get('calendar-link-cancel').props.onClick();h.run()
 expect(h.get('calendar-link-input').props.value).toBe('https://calendar.example/private')
 const event={key:'Escape',preventDefault:vi.fn(),stopPropagation:vi.fn()};h.get('calendar-link-form').props.onKeyDown(event)
 expect(cancel).toHaveBeenCalledTimes(2);expect(event.stopPropagation).toHaveBeenCalled()
})
it('holds dismissal during connection and keeps a failed address for correction',async()=>{
 let finish!:(value:unknown)=>void;const addLink=vi.fn(()=>new Promise(resolve=>{finish=resolve})),cancel=vi.fn(),connected=vi.fn(),busy=vi.fn()
 vi.stubGlobal('window',{yogurt:{calendar:{addLink}}})
 const h=harness(()=>CalendarLinkForm({only:'other',onConnected:connected,onCancel:cancel,onBusyChange:busy}))
 h.get('calendar-link-input').props.onChange({target:{value:'https://calendar.example/private'}});h.run()
 h.get('calendar-link-form').props.onSubmit({preventDefault(){}});h.run()
 expect(h.type('fieldset').props.disabled).toBe(true);expect(busy).toHaveBeenLastCalledWith(true)
 h.get('calendar-link-form').props.onKeyDown({key:'Escape',preventDefault(){},stopPropagation(){}});expect(cancel).not.toHaveBeenCalled()
 finish({ok:false,error:'not-calendar'});await Promise.resolve();h.run()
 expect(h.get('calendar-link-error').props.children).toContain("isn't a calendar")
 expect(h.get('calendar-link-input').props.value).toBe('https://calendar.example/private');expect(busy).toHaveBeenLastCalledWith(false);expect(connected).not.toHaveBeenCalled()
})
it('uses the same keyboard dismissal in setup while keeping its existing extra action',()=>{
 const cancel=vi.fn(),h=harness(()=>CalendarLinkForm({variant:'onboarding',extra:'Not now',onConnected:vi.fn(),onCancel:cancel}))
 expect(h.get('calendar-link-cancel')).toBeUndefined()
 expect(h.all().some(e=>e.props.className==='calendar-link-actions')).toBe(true)
 h.get('calendar-link-form').props.onKeyDown({key:'Escape',preventDefault(){},stopPropagation(){}});expect(cancel).toHaveBeenCalledOnce()
})
it.each([false,true])('restores Add focus after collapse and retains the mounted form (link platform %s)',async link=>{
 const view={status:'granted',calendars:[{id:'work',name:'Work',source:'Calendar',enabled:true}],hideEventsWithoutCallLink:false}
 vi.stubGlobal('window',{yogurt:{capabilities:{calendarLink:link},calendar:{list:async()=>view}},addEventListener:vi.fn(),removeEventListener:vi.fn()})
 const h=harness(CalendarSettings);await Promise.resolve();h.run()
 h.get('calendar-link-add').props.onClick();h.run();expect(h.get('calendar-link-add').props['aria-expanded']).toBe(true)
 expect(h.type(CalendarLinkForm).props.autoFocus).toBe(true)
 h.type(CalendarLinkForm).props.onCancel();h.run()
 expect(h.get('calendar-link-add').props['aria-expanded']).toBe(false);expect(h.focus).toHaveBeenCalledWith({preventScroll:true})
 expect(h.type(CalendarLinkForm)).toBeDefined();expect(h.all().find(e=>e.props.id==='settings-calendar-add')!.props.inert).toBe(true)
 h.get('calendar-link-add').props.onClick();h.run();h.focus.mockClear()
 h.type(CalendarLinkForm).props.onBusyChange(true);h.run();h.type(CalendarLinkForm).props.onConnected();h.run();expect(h.focus).not.toHaveBeenCalled()
 h.type(CalendarLinkForm).props.onBusyChange(false);h.run();expect(h.focus).toHaveBeenCalledWith({preventScroll:true})
})
it.each(['win32', 'linux'])('keeps focus on Meetings when an empty calendar form appears in Settings on %s', async platform => {
 const view = { status: 'notDetermined', calendars: [], hideEventsWithoutCallLink: false }
 vi.stubGlobal('window', { yogurt: { capabilities: capabilities(platform), calendar: { list: async () => view } }, addEventListener: vi.fn(), removeEventListener: vi.fn() })
 let connect = false
 const settings = harness(() => CalendarSettings({ connect }))
 await Promise.resolve()
 settings.run()
 settings.run()
 expect(settings.get('calendar-link-add').props['aria-expanded']).toBe(true)
 const form = harness(() => CalendarLinkForm(settings.type(CalendarLinkForm).props))
 expect(form.focus).not.toHaveBeenCalled()
 expect(settings.focus).not.toHaveBeenCalled()

 // An explicit Connect calendar request can arrive while the empty form is already open.
 connect = true
 settings.run()
 settings.run()
 form.run()
 expect(form.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
 settings.type(CalendarLinkForm).props.onCancel()
 settings.run()
 settings.run()
 expect(settings.get('calendar-link-add').props['aria-expanded']).toBe(false)
 expect(settings.focus).toHaveBeenCalledWith({ preventScroll: true })
})
it('translates the shorter instruction, validation and privacy line in all locales',()=>{
 for(const {id} of LOCALES){setLanguage(id);for(const key of ['Copy the private iCal address from your calendar settings.','Enter an https:// or webcal:// calendar address.', 'The address stays on this computer.','Add a calendar by link',"Calendars from the Mac's Calendar app appear above automatically."]){expect(t(key).trim()).not.toBe('');if(id!=='en')expect(t(key)).not.toBe(key)}}
})

it.each([false,true])('keeps per-calendar controls without a bulk disconnect (link-only %s)',async link=>{
 const view={status:'granted',calendars:[{id:'link:sample',name:'Team calendar',source:'calendar.example.com',enabled:true,link:true}],hideEventsWithoutCallLink:false}
 const setEnabled=vi.fn(async()=>true),removeLink=vi.fn(async()=>true)
 vi.stubGlobal('window',{yogurt:{capabilities:{calendarLink:link},calendar:{list:async()=>view,setEnabled,removeLink}},addEventListener:vi.fn(),removeEventListener:vi.fn()})
 const h=harness(CalendarSettings);await Promise.resolve();h.run()
 expect(h.get('calendar-disconnect')).toBeUndefined();expect(h.get('calendar-disconnect-all')).toBeUndefined()
 expect(h.all().some(e=>e.props.children==='Add a calendar by link')).toBe(true)
 expect(h.all().some(e=>e.props.children==="Calendars from the Mac's Calendar app appear above automatically.")).toBe(!link)
 h.type('input').props.onChange({target:{checked:false}});await Promise.resolve();h.run()
 expect(setEnabled).toHaveBeenCalledWith('link:sample',false);expect(removeLink).not.toHaveBeenCalled()
 h.get('calendar-link-remove').props.onClick({preventDefault(){}});await Promise.resolve();h.run()
 expect(removeLink).toHaveBeenCalledWith('link:sample');expect(setEnabled).toHaveBeenCalledTimes(1)
})
