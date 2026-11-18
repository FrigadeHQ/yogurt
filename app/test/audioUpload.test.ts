import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAudioUploads, uploadedAudio } from '../src/main/audioUpload'
import { openStore, type Store } from '../src/main/store'
import { wavBytes } from '../src/main/asr/transcribe'
import { AUDIO_SPEAKER, uploadDate, uploadStartedAt, uploadDateTime, uploadTime, type AudioUploadStatus } from '../src/shared/audioUpload'
import { transcriptSpeaker } from '../src/shared/transcript'
import { whoSaid } from '../src/shared/exportNotes'
import { transcriptText } from '../src/main/notes/enhance'
import { chunkTranscript } from '../src/main/library/chunks'
import { citationCardPassage } from '../src/shared/citationCard'
import { speakerColor } from '../src/shared/speakerColors'
const modifiedAt=+new Date(2026,10,16,10,30)
let root:string,path:string,store:Store,recording:boolean
const send=vi.fn(),prepared=vi.fn(),changed=vi.fn()
const last=()=>send.mock.calls.at(-1)?.[2] as AudioUploadStatus
let uploads:ReturnType<typeof createAudioUploads>
beforeEach(async()=>{
 root=await mkdtemp(join(tmpdir(),'audio-upload-'));path=join(root,'Planning.wav');store=openStore(':memory:');recording=false;vi.clearAllMocks()
 await writeFile(path,wavBytes(new Float32Array(320)));await utimes(path,modifiedAt/1000,modifiedAt/1000)
 uploads=createAudioUploads({root:join(root,'meetings'),store,recording:()=>recording,prepared,changed,send})
})
afterEach(async()=>{for(const token of uploads.tokens(1))await uploads.cancel(1,token);store.close();await rm(root,{recursive:true,force:true})})
async function prepare(){const file=await uploads.select(1,path);await uploads.start(1,file.token,'Planning',modifiedAt-200);await uploads.write(1,file.token,new Float32Array(3200).fill(.25),1);return file}
it('opens a pending note immediately, then hands a durable playable WAV to the shared queue',async()=>{
 const before=await readFile(path),file=await prepare()
 expect(store.meeting(file.token)).toMatchObject({title:'Planning',transcriptionState:'preparing',transcriptionPending:true})
 expect(last().meetingId).toBe(file.token);await uploads.finish(1,file.token)
 expect(prepared).toHaveBeenCalledExactlyOnceWith(file.token)
 expect(store.meeting(file.token)).toMatchObject({startedAt:modifiedAt-200,endedAt:modifiedAt,durationMs:200})
 const wave=await readFile(join(root,'meetings',file.token,'them.wav'));expect(wave.readUInt32LE(40)).toBe(6400)
 expect(await readFile(path)).toEqual(before)
})
it('cancels preparation without deleting the original or the note someone may have edited',async()=>{
 const file=await prepare();await uploads.cancel(1,file.token)
 expect(store.meeting(file.token)?.transcriptionState).toBe('error');expect(prepared).not.toHaveBeenCalled();expect(await readFile(path)).toEqual(wavBytes(new Float32Array(320)))
})
it('validates ownership and bounds before accepting reads, output and metadata',async()=>{
 const file=await uploads.select(1,path);await expect(uploads.start(2,file.token,'Planning',Date.now())).rejects.toThrow('Unknown')
 await expect(uploads.start(1,file.token,'',Date.now())).rejects.toThrow('Invalid');expect(store.meetings({limit:10})).toEqual([])
 await uploads.start(1,file.token,'Planning',Date.now());await expect(uploads.read(1,file.token,-1,12)).rejects.toThrow('Invalid')
 await expect(uploads.read(1,file.token,0,1024**2+1)).rejects.toThrow('Invalid');await expect(uploads.write(1,file.token,new Float32Array([NaN]),.5)).rejects.toThrow('Invalid')
 await expect(uploads.write(1,file.token,new Float32Array(65537),.5)).rejects.toThrow('Invalid')
})
it('waits for a recording and cancels a paused read without waiting for capture to finish',async()=>{
 const file=await uploads.select(1,path);recording=true;expect(await uploads.start(1,file.token,'Planning',Date.now())).toMatchObject({decode:false})
 recording=false;await uploads.start(1,file.token,'Planning',Date.now());recording=true
 const pending=uploads.read(1,file.token,0,12);const rejection=expect(pending).rejects.toThrow('Cancelled');await uploads.cancel(1,file.token);await rejection
})
it('rejects a changed source and can retry preparation without retaining previous samples',async()=>{
 const file=await prepare();await uploads.failed(1,file.token,'read');await uploads.start(1,file.token,'Revised title',modifiedAt)
 await uploads.write(1,file.token,new Float32Array(1600),1);await uploads.finish(1,file.token)
 expect(store.meeting(file.token)).toMatchObject({title:'Revised title',durationMs:100})
})
it('marks preparation interrupted by a restart as failed rather than claiming it resumed',async()=>{
 const file=await prepare();store.interruptAudioPreparations();expect(store.meeting(file.token)?.transcriptionState).toBe('error');expect(store.meeting(file.token)?.transcriptionPending).toBeUndefined()
})

it('uses local calendar dates and keeps the file time when changing its date',()=>{
  const original=+new Date(2026,10,16,23,42)
  expect(uploadDate(original)).toBe('2026-11-16')
  const changed=uploadStartedAt('2026-11-17',original)!
  expect(new Date(changed).getHours()).toBe(23);expect(new Date(changed).getDate()).toBe(17)
  expect(uploadStartedAt('2026-02-31',original)).toBeUndefined();expect(uploadStartedAt('bad',original)).toBeUndefined()
})
it('never labels the uploaded track as You, Them or a named person in UI, exports and notes',()=>{
  const line={id:1,meetingId:'sample',track:'them' as const,speaker:AUDIO_SPEAKER,startMs:0,endMs:100,text:'A sample line'}
  expect(transcriptSpeaker(line)).toBe('Audio');expect(whoSaid(line)).toBe('Audio');expect(transcriptText([line])).toBe('Audio: A sample line')
  expect(speakerColor('them',AUDIO_SPEAKER,[AUDIO_SPEAKER])).toBeUndefined()
})

it('keeps Audio out of indexed people and strips its prefix from citation excerpts', () => {
  const line = { id: 1, meetingId: 'sample', track: 'them' as const, speaker: AUDIO_SPEAKER, startMs: 0, endMs: 100, text: 'A sample line' }
  expect(chunkTranscript([line])[0]).toMatchObject({ text: 'Audio: A sample line', speakers: [] })
  const preview = citationCardPassage({ n: 1, meetingId: 'sample', title: 'Planning', startedAt: 0, atMs: 0, excerpt: 'Audio: A sample line', transcript: { speakers: [], lines: [line] } }, 'A sample line')
  expect(preview.match.text).toBe('A sample line')
  expect(transcriptSpeaker(preview.lines[0])).toBe('Audio')
})

it('shows the inferred start even across midnight, then keeps its time on an edited date', () => {
  const modified = +new Date(2026, 10, 16, 0, 30), inferred = modified - 2 * 60 * 60 * 1000
  expect(uploadDate(inferred)).toBe('2026-11-15')
  expect(uploadTime(inferred)).toBe('22:30')
  expect(uploadDateTime('2026-11-20', '22:30', inferred)).toBe(+new Date(2026, 10, 20, 22, 30))
  expect(uploadDateTime('2026-11-20', '14:00', inferred)).toBe(+new Date(2026, 10, 20, 14))
  expect(uploadDateTime('2026-11-20', '25:30', inferred)).toBeUndefined()
  expect(uploadDateTime('2026-02-31', '14:00', inferred)).toBeUndefined()
})
it('keeps the inferred local time when the chosen day has a different daylight-saving offset', () => {
  const inferred = +new Date(2026, 0, 15, 12, 55, 30, 500)
  expect(uploadDateTime('2026-07-15', '12:55', inferred)).toBe(+new Date(2026, 6, 15, 12, 55, 30, 500))
})
it('allows bounded metadata reads before creating any output or meeting', async () => {
  const file = await uploads.select(1,path)
  expect(uploads.info(1,file.token)).toEqual(file)
  expect(() => uploads.info(2,file.token)).toThrow('Unknown')
  expect(await uploads.read(1,file.token,0,12)).toEqual((await readFile(path)).subarray(0,12))
  expect(store.meetings({limit:10})).toEqual([])
  await uploads.cancel(1,file.token)
  expect(await readFile(path)).toEqual(wavBytes(new Float32Array(320)))
})

it('rejects a future meeting day at the main-process boundary',async()=>{
 const file=await uploads.select(1,path),tomorrow=new Date();tomorrow.setDate(tomorrow.getDate()+1)
 await expect(uploads.start(1,file.token,'Planning',+tomorrow)).rejects.toThrow('Invalid audio details')
 expect(store.meetings({limit:10})).toEqual([])
})

it('exposes preparation before the first decoded sample and keeps edits made while it runs',async()=>{
 const file=await uploads.select(1,path);await uploads.start(1,file.token,'Planning',modifiedAt)
 expect(last()).toMatchObject({phase:'preparing',meetingId:file.token,fraction:0})
 expect(prepared).not.toHaveBeenCalled();expect(store.meeting(file.token)?.transcriptionState).toBe('preparing')
 store.updateMeeting(file.token,{title:'Edited on the note',startedAt:modifiedAt-60000})
 await uploads.write(1,file.token,new Float32Array(1600),1);await uploads.finish(1,file.token)
 expect(store.meeting(file.token)).toMatchObject({title:'Edited on the note',startedAt:modifiedAt-60000,endedAt:modifiedAt-59900,durationMs:100})
})
