import type { Store } from './store'
import type { Track } from './capture'
import type { RecordedOptions } from './asr'
import type { TranscriptionState } from '../shared/transcription'

/** One queue for uploaded audio and saved recordings. Stopping never deletes either. */
export function createSavedTranscriptions(d: {
  store: Store; ready: () => boolean; recording: () => boolean
  tracks: (id: string) => Promise<Partial<Record<Track,AsyncIterable<Float32Array>>>>
  transcribe: (id: string, tracks: Partial<Record<Track,AsyncIterable<Float32Array>>>, options: RecordedOptions) => Promise<boolean>
  draft?: (id:string) => void
  changed: (id: string,replaced?:boolean) => void; summarize: (id: string) => void
}) {
  let running: { id:string; abort:AbortController; stopped:boolean } | undefined
  let draining=false, quitting=false
  const set=(id:string,state:TranscriptionState)=>{if(d.store.meeting(id)){d.store.updateMeeting(id,{transcriptionState:state});d.changed(id)}}
  const stopped=(id:string)=>{if(d.store.meeting(id)?.transcriptionAgain){d.store.cancelTranscriptionReplacement(id);d.draft?.(id);d.changed(id)}else set(id,'stopped')}
  const pump=async()=>{
    if(draining||quitting)return
    draining=true
    try {
      for(const meeting of d.store.untranscribedMeetings()) {
        if(quitting)break
        const id=meeting.id
        const current=d.store.meeting(id)
        if(!current||current.trashedAt!=null||['stopped','error','preparing','done'].includes(current.transcriptionState??''))continue
        if(d.recording()){set(id,'waiting-recording');continue}
        if(!d.ready()){set(id,'waiting-model');continue}
        const job={id,abort:new AbortController(),stopped:false};running=job;set(id,'transcribing')
        try {
          const tracks=await d.tracks(id)
          if(!Object.keys(tracks).length)throw new Error('No saved audio')
          const segments=meeting.transcriptionAgain?d.store.transcriptionDraft(id):d.store.segments(id,{hidden:true})
          const fromMs:Partial<Record<Track,number>>={}
          for(const segment of segments)fromMs[segment.track]=Math.max(fromMs[segment.track]??0,segment.endMs)
          const complete=await d.transcribe(id,tracks,{signal:job.abort.signal,fromMs,...(meeting.transcriptionAgain?{save:segs=>{d.store.addTranscriptionDraft(id,segs);d.draft?.(id)}}:{})})
          if(!d.store.meeting(id)||d.store.meeting(id)?.trashedAt!=null)continue
          if(job.abort.signal.aborted){if(job.stopped)stopped(id);else set(id,d.recording()?'waiting-recording':'queued');continue}
          if(!complete)throw new Error('Saved transcription incomplete')
          if(meeting.transcriptionAgain&&!d.store.transcriptionDraft(id).some(line=>!line.hidden&&line.text.trim())){d.store.cancelTranscriptionReplacement(id);d.changed(id);continue}
          if(meeting.transcriptionAgain)d.store.commitTranscriptionDraft(id)
          else d.store.updateMeeting(id,{transcriptionPending:false,transcriptionState:'done'})
          d.changed(id,!!meeting.transcriptionAgain)
          // Replacing a transcript must not overwrite an existing or edited summary.
          if(!d.store.notes(id).enhanced?.trim())d.summarize(id)
        } catch(error) {
          if(d.store.meeting(id)){if(job.stopped)stopped(id);else set(id,job.abort.signal.aborted?'queued':'error')}
          if(!job.abort.signal.aborted)console.error('Saved transcription failed',id,error)
        } finally { if(running===job)running=undefined }
      }
    } finally {draining=false;if(!quitting&&!d.recording()&&d.ready()&&d.store.untranscribedMeetings().some(m=>m.transcriptionState==='queued'))queueMicrotask(()=>void pump())}
  }
  return {
    async start(id:string,again=false) {
      const meeting=d.store.meeting(id)
      if(!meeting||meeting.trashedAt!=null||meeting.state==='recording'||running?.id===id)return false
      if(again)d.store.beginTranscriptionReplacement(id)
      d.store.updateMeeting(id,{transcriptionPending:true,transcriptionState:'queued'});d.changed(id);void pump();return true
    },
    stop(id:string) {
      const meeting=d.store.meeting(id)
      if(!meeting||!meeting.transcriptionPending||meeting.state==='recording')return
      if(running?.id===id){running.stopped=true;running.abort.abort();return}
      stopped(id)
    },
    pause(){running?.abort.abort()},
    shutdown(){quitting=true;running?.abort.abort()},
    resume(){quitting=false;void pump()},
    pump,
    owns:(id:string)=>running?.id===id,
  }
}
