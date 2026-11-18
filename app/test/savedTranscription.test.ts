import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {openStore,type Store} from '../src/main/store'
import {createSavedTranscriptions} from '../src/main/savedTranscription'
import {feedRecording} from '../src/main/asr/backfill'
let store:Store,model=true,recording=false
const transcribe=vi.fn(),summarize=vi.fn(),changed=vi.fn()
let jobs:ReturnType<typeof createSavedTranscriptions>
const line=(id:string,start=0,end=100,text='A sample line')=>({meetingId:id,track:'them' as const,startMs:start,endMs:end,text,speaker:null})
const note=()=>store.createMeeting({title:'Planning',startedAt:100,endedAt:200,state:'stopped',attendees:[],eventId:null,app:null})
const make=()=>createSavedTranscriptions({store,ready:()=>model,recording:()=>recording,tracks:async()=>({them:(async function*(){yield new Float32Array(1600)})()}),transcribe,summarize,changed})
beforeEach(()=>{store=openStore(':memory:');model=true;recording=false;vi.resetAllMocks();transcribe.mockResolvedValue(true);jobs=make()})
afterEach(async()=>{jobs.shutdown();await vi.waitFor(()=>expect(store.meetings({limit:20}).some(m=>jobs.owns(m.id))).toBe(false));store.close()})
it('stops without deleting lines, continues at their saved boundary, and summarizes only on completion',async()=>{
 const id=note().id
 transcribe.mockImplementationOnce(async(_id,_tracks,options)=>{store.addSegments([line(id)]);return new Promise(resolve=>options.signal.addEventListener('abort',()=>resolve(false),{once:true}))})
 await jobs.start(id);await vi.waitFor(()=>expect(store.segments(id)).toHaveLength(1));jobs.stop(id)
 await vi.waitFor(()=>expect(jobs.owns(id)).toBe(false))
 expect(store.meeting(id)).toMatchObject({transcriptionState:'stopped',transcriptionPending:true});expect(summarize).not.toHaveBeenCalled()
 await jobs.pump();expect(transcribe).toHaveBeenCalledTimes(1)
 transcribe.mockImplementationOnce(async(_id,_tracks,options)=>{expect(options.fromMs).toEqual({them:100});store.addSegments([line(id,100,200,'Next line')]);return true})
 await jobs.start(id);await vi.waitFor(()=>expect(store.meeting(id)?.transcriptionState).toBe('done'))
 expect(store.segments(id).map(s=>s.text)).toEqual(['A sample line','Next line']);expect(summarize).toHaveBeenCalledExactlyOnceWith(id)
})
it('stages a replacement durably and keeps the old transcript and summary through quit and restart',async()=>{
 const id=note().id;store.addSegments([line(id,0,300,'Original words')]);store.db.prepare('INSERT INTO notes (meeting_id,mine,enhanced) VALUES (?,?,?)').run(id,'','Edited summary')
 transcribe.mockImplementationOnce(async(_id,_tracks,options)=>{options.save([line(id,0,100,'Replacement start')]);return new Promise(resolve=>options.signal.addEventListener('abort',()=>resolve(false),{once:true}))})
 await jobs.start(id,true);await vi.waitFor(()=>expect(store.transcriptionDraft(id)).toHaveLength(1));jobs.shutdown();await vi.waitFor(()=>expect(jobs.owns(id)).toBe(false))
 expect(store.segments(id)[0].text).toBe('Original words');expect(store.notes(id).enhanced).toBe('Edited summary')
 jobs=make();expect(transcribe).toHaveBeenCalledTimes(1)
 transcribe.mockImplementationOnce(async(_id,_tracks,options)=>{expect(options.fromMs).toEqual({them:100});options.save([line(id,100,200,'Replacement end')]);return true})
 await jobs.start(id);await vi.waitFor(()=>expect(store.meeting(id)?.transcriptionState).toBe('done'))
 expect(store.segments(id).map(s=>s.text)).toEqual(['Replacement start','Replacement end']);expect(store.transcriptionDraft(id)).toEqual([])
 expect(store.notes(id).enhanced).toBe('Edited summary');expect(summarize).not.toHaveBeenCalled()
})
it('waits for the model, yields to a recording and resumes without clearing partial lines',async()=>{
 const id=note().id;model=false;await jobs.start(id);expect(store.meeting(id)?.transcriptionState).toBe('waiting-model');expect(transcribe).not.toHaveBeenCalled()
 transcribe.mockImplementationOnce(async(_id,_tracks,options)=>{store.addSegments([line(id)]);return new Promise(resolve=>options.signal.addEventListener('abort',()=>resolve(false),{once:true}))})
 model=true;jobs.resume();await vi.waitFor(()=>expect(store.segments(id)).toHaveLength(1));recording=true;jobs.pause();await vi.waitFor(()=>expect(jobs.owns(id)).toBe(false))
 expect(store.meeting(id)?.transcriptionPending).toBe(true);expect(store.segments(id)).toHaveLength(1)
 recording=false;jobs.resume();await vi.waitFor(()=>expect(store.meeting(id)?.transcriptionState).toBe('done'));expect(transcribe.mock.calls.at(-1)?.[2].fromMs).toEqual({them:100})
})
it('leaves failures retryable and never writes a summary from a failed partial result',async()=>{
 const id=note().id;transcribe.mockResolvedValueOnce(false);await jobs.start(id);await vi.waitFor(()=>expect(store.meeting(id)?.transcriptionState).toBe('error'))
 expect(summarize).not.toHaveBeenCalled();await jobs.pump();expect(transcribe).toHaveBeenCalledTimes(1)
 await jobs.start(id);await vi.waitFor(()=>expect(store.meeting(id)?.transcriptionState).toBe('done'))
})
it('uses the same queue for an existing empty recording and an upload and runs one at a time',async()=>{
 const first=note().id,second=note().id;store.db.prepare('UPDATE meetings SET source=? WHERE id=?').run('audio-file',second)
 let release:()=>void=()=>{}
 transcribe.mockImplementationOnce(()=>new Promise<boolean>(resolve=>{release=()=>resolve(true)}))
 await jobs.start(first);await vi.waitFor(()=>expect(transcribe).toHaveBeenCalledOnce());await jobs.start(second);expect(transcribe).toHaveBeenCalledOnce()
 release();await vi.waitFor(()=>expect(store.meeting(second)?.transcriptionState).toBe('done'));expect(transcribe).toHaveBeenCalledTimes(2)
})
it('skips already persisted audio with absolute timestamps, including a partial input piece',async()=>{
 const push=vi.fn();const samples=new Float32Array(3200).map((_,i)=>i)
 expect(await feedRecording({tracks:{them:(async function*(){yield samples})()},fromMs:{them:150},push,backlogMs:()=>0})).toBe(200)
 expect(push).toHaveBeenCalledOnce();expect(push.mock.calls[0][1]).toBe(150);expect(push.mock.calls[0][2]).toHaveLength(800);expect(push.mock.calls[0][2][0]).toBe(2400)
})

it('cancelling a complete replacement restores the original without a stopped or pending state',async()=>{
 const id=note().id;store.addSegments([line(id,0,300,'Original')]);store.setNotes(id,{enhanced:'Saved summary'})
 transcribe.mockImplementationOnce(async(_id,_tracks,options)=>{options.save([line(id,0,100,'Draft')]);return new Promise(resolve=>options.signal.addEventListener('abort',()=>resolve(false),{once:true}))})
 await jobs.start(id,true);await vi.waitFor(()=>expect(store.transcriptionDraft(id)).toHaveLength(1));jobs.stop(id);await vi.waitFor(()=>expect(jobs.owns(id)).toBe(false))
 expect(store.meeting(id)).toMatchObject({transcriptionState:'done'});expect(store.meeting(id)?.transcriptionPending).not.toBe(true);expect(store.meeting(id)?.transcriptionAgain).not.toBe(true)
 expect(store.transcriptionDraft(id)).toEqual([]);expect(store.segments(id).map(l=>l.text)).toEqual(['Original']);expect(store.notes(id).enhanced).toBe('Saved summary')
 await jobs.pump();expect(transcribe).toHaveBeenCalledOnce();expect(summarize).not.toHaveBeenCalled()
})
it('cancelling a queued replacement also restores whether the original was partial',async()=>{
 const id=note().id;store.addSegments([line(id)]);store.updateMeeting(id,{transcriptionPending:true});model=false
 await jobs.start(id,true);jobs.stop(id)
 expect(store.meeting(id)).toMatchObject({transcriptionState:'stopped',transcriptionPending:true});expect(store.meeting(id)?.transcriptionAgain).not.toBe(true)
})

it('retains a complete original when a replacement finishes without usable words',async()=>{
 const id=note().id;store.addSegments([line(id,0,300,'Original')]);await jobs.start(id,true)
 await vi.waitFor(()=>expect(jobs.owns(id)).toBe(false));expect(store.segments(id).map(l=>l.text)).toEqual(['Original']);expect(store.meeting(id)?.transcriptionAgain).not.toBe(true);expect(summarize).not.toHaveBeenCalled()
})
