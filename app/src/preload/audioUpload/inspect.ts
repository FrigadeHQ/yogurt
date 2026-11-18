import { AudioReader, fail, text, type AudioSource } from './read'
import { wavInfo } from './decode'
import { m4a } from './m4a'
import { mp3Duration } from './mp3'

/** Read duration from container metadata or compressed frame headers, never decoded audio. */
export async function inspectAudioUpload(source: AudioSource, signal: AbortSignal): Promise<number> {
  const reader=new AudioReader(source,signal),head=await reader.read(0,Math.min(12,source.size))
  let duration:number
  if(text(head,0,4)==='RIFF'&&text(head,8,4)==='WAVE'){
    const info=await wavInfo(reader);duration=info.size/info.align/info.rate*1000
  }else if(text(head,4,4)==='ftyp')duration=(await m4a(reader)).durationMs
  else duration=await mp3Duration(reader)
  signal.throwIfAborted()
  if(!Number.isFinite(duration)||duration<=0||duration>24*60*60*1000)fail('format')
  return duration
}
