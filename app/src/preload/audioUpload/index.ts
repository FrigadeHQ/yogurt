import { ipcRenderer } from 'electron'
import type { YogurtApi } from '../../shared/types'
import type { AudioUploadStatus } from '../../shared/audioUpload'
import { inspectAudioUpload } from './inspect'
import { decodeAudioUpload } from './decode'
import { AudioFileError } from './read'
const inspections=new Map<string,{abort:AbortController;promise:Promise<number>}>()
const decoding=new Map<string,AbortController>()
export const audioUpload:YogurtApi['audioUpload']={
  pick:()=>ipcRenderer.invoke('audio-upload:pick'),
  inspect(token){
    let task=inspections.get(token)
    if(!task){
      const abort=new AbortController()
      const promise=ipcRenderer.invoke('audio-upload:info',token).then(file=>inspectAudioUpload({size:file.size,read:async(offset,length)=>new Uint8Array(await ipcRenderer.invoke('audio-upload:read',token,offset,length))},abort.signal))
      task={abort,promise};inspections.set(token,task)
      void promise.catch(()=>{if(inspections.get(token)===task)inspections.delete(token)})
    }
    return task.promise
  },
  async start(token,title,at){
    if(decoding.has(token))return
    const abort=new AbortController();decoding.set(token,abort)
    try{
      const start=await ipcRenderer.invoke('audio-upload:start',token,title,at)
      if(!start.decode)return
      await decodeAudioUpload({size:start.size,read:async(offset,length)=>new Uint8Array(await ipcRenderer.invoke('audio-upload:read',token,offset,length))},async(samples,fraction)=>{
        abort.signal.throwIfAborted()
        if(samples.length)await ipcRenderer.invoke('audio-upload:write',token,samples,fraction)
      },abort.signal)
      abort.signal.throwIfAborted();await ipcRenderer.invoke('audio-upload:finish',token)
    }catch(error){if(!abort.signal.aborted)await ipcRenderer.invoke('audio-upload:failed',token,error instanceof AudioFileError?error.kind:'read')}
    finally{decoding.delete(token);inspections.delete(token)}
  },
  async cancel(token){inspections.get(token)?.abort.abort();inspections.delete(token);decoding.get(token)?.abort();await ipcRenderer.invoke('audio-upload:cancel',token)},
  onStatus(cb){const listener=(_event:unknown,token:string,status:AudioUploadStatus)=>cb(token,status);ipcRenderer.on('audio-upload:status',listener);return()=>ipcRenderer.removeListener('audio-upload:status',listener)},
}
