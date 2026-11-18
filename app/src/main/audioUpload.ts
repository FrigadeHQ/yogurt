import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { Store } from './store'
import { uploadDayAllowed, type AudioUploadFile, type AudioUploadStatus } from '../shared/audioUpload'
import { t } from '../shared/i18n'
import { wavBytes } from './asr/transcribe'

async function writeAll(file: FileHandle, bytes: Uint8Array, position: number) {
  let written = 0
  while (written < bytes.length) {
    const { bytesWritten } = await file.write(bytes, written, bytes.length - written, position + written)
    if (!bytesWritten) throw new Error('Audio write failed')
    written += bytesWritten
  }
}

type Job = { owner: number; file: AudioUploadFile; input: FileHandle; output?: FileHandle; dir: string; samples: number; modified: number; status?: AudioUploadStatus; id?: string; title?: string; at?: number; cancelled?: boolean; durable?: boolean; writing: Promise<void>; operation?: Promise<unknown>; wait?: Promise<void>; wake?: () => void }
type UploadStore = Pick<Store,'createMeeting'|'updateMeeting'|'meeting'|'interruptAudioPreparations'>
/** Uploaded audio is canonical 16 kHz mono PCM; stream it without reading hours of audio into RAM. */
export async function* uploadedAudio(file: string): AsyncGenerator<Float32Array> {
  let rest:Buffer=Buffer.alloc(0)
  for await(const bytes of createReadStream(file,{start:44,highWaterMark:32768})) {
    const b=rest.length?Buffer.concat([rest,bytes]):bytes as Buffer,n=b.length-b.length%2,out=new Float32Array(n/2)
    for(let i=0;i<out.length;i++)out[i]=b.readInt16LE(i*2)/32768
    rest=b.subarray(n);if(out.length)yield out
  }
  if(rest.length)throw new Error('Incomplete PCM audio')
}
export function createAudioUploads(d:{
  root: string; store:UploadStore; recording:()=>boolean
  prepared:(id:string)=>void; changed:()=>void; send:(owner:number,token:string,status:AudioUploadStatus)=>void
}) {
  const jobs=new Map<string,Job>()
  const get=(owner:number,token:unknown)=>{const j=typeof token==='string'?jobs.get(token):undefined;if(!j||j.owner!==owner)throw new Error('Unknown audio selection');return j}
  const tell=(j:Job,status:AudioUploadStatus)=>{const changed=j.status?.phase!==status.phase;j.status={...status,...(j.id?{meetingId:j.id}:{})};if(j.id&&changed&&status.phase!=='done'){d.store.updateMeeting(j.id,{transcriptionState:status.phase==='error'?'error':status.phase==='cancelling'?'stopped':status.phase==='reading'||status.phase==='waiting-recording'?'preparing':status.phase});d.changed()}d.send(j.owner,j.file.token,j.status)}
  const control=async<T>(j:Job,task:()=>Promise<T>):Promise<T>=>{
    if(j.operation)throw new Error('Audio upload is busy')
    const operation=task();j.operation=operation
    try{return await operation}finally{if(j.operation===operation)j.operation=undefined}
  }
  const waitForRecording=async(j:Job)=>{
    while(d.recording()&&!j.cancelled){
      tell(j,{phase:'waiting-recording'})
      j.wait??=new Promise<void>(resolve=>{j.wake=()=>{j.wait=undefined;j.wake=undefined;resolve()}})
      await j.wait
    }
    if(j.cancelled)throw new Error('Cancelled')
  }
  const cleanup=async(j:Job)=>{await j.output?.close().catch(()=>{});j.output=undefined;await j.input.close().catch(()=>{});await rm(j.dir,{recursive:true,force:true})}
  return {
    async select(owner:number,path:string):Promise<AudioUploadFile> {
      for(const [token,j] of jobs)if(j.status?.phase==='done')jobs.delete(token)
      if([...jobs.values()].some(j=>j.status?.phase!=='done'&&!j.cancelled))throw new Error('Audio upload is busy')
      if(!['.mp3','.m4a','.wav'].includes(extname(path).toLowerCase()))throw new Error('Unsupported audio format')
      const input=await open(path,'r')
      try {
        const stat=await input.stat();if(!stat.isFile()||stat.size<12||stat.size>8*1024**3)throw new Error('Unsupported audio file')
        const token=randomUUID(),name=basename(path),file={token,name,title:name.slice(0,-extname(name).length).trim().slice(0,200)||t('Recording'),modifiedAt:stat.mtimeMs,size:stat.size}
        jobs.set(token,{owner,file,input,dir:join(d.root,'.uploads',token),samples:0,modified:stat.mtimeMs,writing:Promise.resolve()});return file
      }catch(error){await input.close();throw error}
    },
    info(owner:number,token:unknown){return get(owner,token).file},
    async start(owner:number,token:unknown,title:unknown,at:unknown):Promise<{size:number;decode:boolean}> {
      const j=get(owner,token)
      return control(j,async()=>{
      if(j.cancelled||j.output)throw new Error('Audio upload is busy')
      if(typeof title!=='string'||!title.trim()||title.length>200||typeof at!=='number'||!Number.isFinite(at)||!uploadDayAllowed(at)||at<new Date(1900,0,1).getTime()||at>new Date(10000,0,1).getTime()-86400000)throw new Error('Invalid audio details')
      if(d.recording()){tell(j,{phase:'error',error:'busy'});return{size:j.file.size,decode:false}}
      j.title=title.replace(/\s+/g,' ').trim();j.at=at
      if(!j.id){const id=j.file.token;d.store.createMeeting({title:j.title,titleSource:'user',source:'audio-file',startedAt:at,endedAt:null,eventId:null,app:null,attendees:[],state:'stopped',transcriptionPending:true},id);j.id=id}
      d.store.updateMeeting(j.id,{title:j.title,startedAt:at,transcriptionPending:true,transcriptionState:'preparing'});d.changed()
      await mkdir(j.dir,{recursive:true});j.output=await open(join(j.dir,'audio.wav'),'w');await writeAll(j.output,wavBytes(new Float32Array(0)),0)
      j.writing=Promise.resolve();j.samples=0;if(!j.cancelled)tell(j,{phase:'preparing',fraction:0});return{size:j.file.size,decode:true}
      })
    },
    async read(owner:number,token:unknown,offset:unknown,length:unknown):Promise<Uint8Array> {
      const j=get(owner,token)
      await waitForRecording(j)
      if(j.cancelled||typeof offset!=='number'||typeof length!=='number'||!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<1||length>1024**2||offset+length>j.file.size)throw new Error('Invalid audio read')
      const b=Buffer.alloc(length),{bytesRead}=await j.input.read(b,0,length,offset)
      if(bytesRead!==length)throw new Error('Audio file changed');return b
    },
    async write(owner:number,token:unknown,samples:unknown,fraction:unknown) {
      const j=get(owner,token)
      await waitForRecording(j)
      if(j.cancelled||!j.output||!(samples instanceof Float32Array)||samples.length>65536||typeof fraction!=='number'||!Number.isFinite(fraction)||fraction<0||fraction>1||samples.some(x=>!Number.isFinite(x)))throw new Error('Invalid audio samples')
      if(j.samples+samples.length>16000*60*60*24)throw new Error('Audio exceeds 24 hours')
      const bytes=wavBytes(samples).subarray(44),offset=44+j.samples*2;j.samples+=samples.length
      j.writing=j.writing.then(async()=>{if(j.cancelled)throw new Error('Cancelled');await writeAll(j.output!,bytes,offset)})
      await j.writing
      if(!j.cancelled)tell(j,{phase:'preparing',fraction})
    },
    async finish(owner:number,token:unknown) {
      const j=get(owner,token)
      return control(j,async()=>{
      if(j.cancelled||!j.output||!j.samples||j.at==null||!j.title)throw new Error('Incomplete audio')
      await j.writing
      const stat=await j.input.stat();if(stat.size!==j.file.size||stat.mtimeMs!==j.modified)throw new Error('Audio file changed')
      const header=wavBytes(new Float32Array(0));header.writeUInt32LE(36+j.samples*2,4);header.writeUInt32LE(j.samples*2,40)
      await writeAll(j.output,header,0);await j.output.sync();await j.output.close();j.output=undefined
      if(j.cancelled)return
      const id=j.file.token,durationMs=j.samples/16,startedAt=d.store.meeting(id)?.startedAt??j.at,folder=join(d.root,id)
      await mkdir(folder,{recursive:true});await rename(join(j.dir,'audio.wav'),join(folder,'them.wav'))
      j.id=id;j.durable=true;d.store.updateMeeting(id,{durationMs,endedAt:startedAt+durationMs});if(!j.cancelled){d.prepared(id);tell(j,{phase:'done',meetingId:id})}await cleanup(j)
      })
    },
    async failed(owner:number,token:unknown,error:unknown) {
      const j=get(owner,token);if(j.cancelled)return
      await j.writing.catch(()=>{});await j.output?.close().catch(()=>{});j.output=undefined
      tell(j,{phase:'error',error:error==='format'?'format':'read'})
    },
    async cancel(owner:number,token:unknown) {
      const j=get(owner,token);if(j.status?.phase==='done')return
      j.cancelled=true;j.wake?.();tell(j,{phase:'cancelling'})
      await j.operation?.catch(()=>{});await j.writing.catch(()=>{})
      if(j.id){d.store.updateMeeting(j.id,{transcriptionPending:!!j.durable,transcriptionState:j.durable?'stopped':'error'});d.changed()}
      await cleanup(j);jobs.delete(j.file.token)
    },
    resume(){for(const j of jobs.values()){if(!d.recording())j.wake?.()}},
    preparing:(id:string)=>[...jobs.values()].find(j=>j.id===id&&j.status?.phase!=='done'),
    owns:(id:string)=>[...jobs.values()].some(j=>j.id===id&&j.status?.phase!=='done'),
    tokens:(owner:number)=>[...jobs.values()].filter(j=>j.owner===owner&&j.status?.phase!=='done').map(j=>j.file.token),
  }
}
