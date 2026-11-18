import { AudioReader, AudioFileError, fail, text, view, type AudioSource } from './read'
import { AudioResampler } from './resample'
import { mp3 } from './mp3'
import { m4a } from './m4a'
export type AudioSink = (samples: Float32Array, fraction: number) => Promise<void>
export async function wavInfo(reader: AudioReader) {
  let at=12,format:Uint8Array|undefined,dataAt=0,size=0
  while(at+8<=reader.source.size){
    const h=await reader.read(at,8),n=view(h).getUint32(4,true),kind=text(h,0,4)
    if(at+8+n>reader.source.size)fail()
    if(kind==='fmt '){if(n<16||n>128)fail('format');format=(await reader.read(at+8,n)).slice()}
    if(kind==='data'){if(dataAt)fail('format');dataAt=at+8;size=n}
    at+=8+n+(n%2)
  }
  if(!format||!dataAt||!size)fail()
  const f=view(format),channels=f.getUint16(2,true),rate=f.getUint32(4,true),align=f.getUint16(12,true),bits=f.getUint16(14,true)
  let kind=f.getUint16(0,true)
  if(kind===65534){
    const guidTail=[0,0,0,0,16,0,128,0,0,170,0,56,155,113]
    if(format.length<40||f.getUint16(16,true)<22||f.getUint16(18,true)!==bits||guidTail.some((byte,i)=>format![26+i]!==byte))fail('format')
    kind=f.getUint16(24,true)
  }
  if(![1,3].includes(kind)||channels<1||channels>8||![8,16,24,32].includes(bits)||(kind===3&&bits!==32)||align!==channels*bits/8||size%align)fail('format')
  if(rate<8000||rate>192000)fail('format')
  return {channels,rate,align,bits,kind,dataAt,size}
}
async function wav(reader: AudioReader, sink: AudioSink) {
  const {channels,rate,align,bits,kind,dataAt,size}=await wavInfo(reader)
  const resampler=new AudioResampler(rate),bytes=bits/8
  for(let offset=0;offset<size;){
    const length=Math.min(size-offset,align*8192),b=await reader.read(dataAt+offset,length),v=view(b),mono=new Float32Array(length/align)
    for(let i=0;i<mono.length;i++)for(let channel=0;channel<channels;channel++){
      const j=i*align+channel*bytes
      const sample=kind===3?v.getFloat32(j,true):bits===8?(b[j]-128)/128:bits===16?v.getInt16(j,true)/32768:bits===24?((b[j]|b[j+1]<<8|b[j+2]<<16)<<8>>8)/8388608:v.getInt32(j,true)/2147483648
      if(!Number.isFinite(sample))fail()
      mono[i]+=sample/channels
    }
    offset+=length
    const out=resampler.push(mono)
    if(out.length)await sink(out,offset/size)
  }
  await sink(resampler.push(new Float32Array(0),true),1)
}
/** Decode one bounded packet batch at a time using Chromium's built-in codecs. */
export async function decodeAudioUpload(source: AudioSource, sink: AudioSink, signal: AbortSignal): Promise<void> {
  const reader=new AudioReader(source,signal),head=await reader.read(0,Math.min(12,source.size))
  if(text(head,0,4)==='RIFF'&&text(head,8,4)==='WAVE')return wav(reader,sink)
  const encoded=text(head,4,4)==='ftyp'?await m4a(reader):await mp3(reader)
  if(typeof AudioDecoder==='undefined'||!(await AudioDecoder.isConfigSupported(encoded.config)).supported)fail('format')
  let frames:AudioData[]=[],failure:Error|undefined,resampler:AudioResampler|undefined,rate=0,written=false
  const decoder=new AudioDecoder({output:frame=>frames.push(frame),error:error=>{failure=error}})
  const abort=()=>{if(decoder.state!=='closed')decoder.close()}
  signal.addEventListener('abort',abort,{once:true})
  const flush=async(fraction:number)=>{
    signal.throwIfAborted();await decoder.flush();if(failure)throw failure
    // Send bounded PCM batches, not one IPC round trip for each compressed frame.
    let batch=new Float32Array(65536),used=0
    const send=async()=>{if(used){await sink(batch.subarray(0,used),fraction);batch=new Float32Array(65536);used=0}}
    for(const frame of frames){
      signal.throwIfAborted()
      if(!resampler){rate=frame.sampleRate;resampler=new AudioResampler(rate)}
      if(frame.sampleRate!==rate||frame.numberOfChannels<1||frame.numberOfChannels>8||frame.numberOfFrames>16384)fail('format')
      const start=Math.max(0,Math.ceil(((encoded.trimSeconds??0)-frame.timestamp/1e6)*rate)),endSeconds='endSeconds' in encoded?encoded.endSeconds as number|undefined:undefined
      const end=Math.min(frame.numberOfFrames,endSeconds==null?frame.numberOfFrames:Math.floor((endSeconds-frame.timestamp/1e6)*rate))
      if(end>start){
        const mono=new Float32Array(end-start),plane=new Float32Array(frame.numberOfFrames)
        for(let channel=0;channel<frame.numberOfChannels;channel++){
          frame.copyTo(plane,{planeIndex:channel,format:'f32-planar'})
          for(let i=start;i<end;i++){if(!Number.isFinite(plane[i]))fail();mono[i-start]+=plane[i]/frame.numberOfChannels}
        }
        const out=resampler.push(mono)
        for(let at=0;at<out.length;){const n=Math.min(out.length-at,batch.length-used);batch.set(out.subarray(at,at+n),used);used+=n;at+=n;if(used===batch.length)await send()}
        if(out.length)written=true
      }
      frame.close()
    }
    frames=[];await send()
  }
  try{
    decoder.configure(encoded.config)
    let batch=0,fraction=0
    for await(const packet of encoded.packets){
      signal.throwIfAborted();if(failure)throw failure
      decoder.decode(new EncodedAudioChunk({type:'key',timestamp:packet.timestamp,data:packet.data}))
      fraction=packet.fraction
      if(++batch===64){await flush(fraction);batch=0}
    }
    await flush(1)
    if(!written||!resampler)fail()
    await sink(resampler.push(new Float32Array(0),true),1)
  }catch(error){signal.throwIfAborted();throw error instanceof AudioFileError?error:new AudioFileError('read')}
  finally{signal.removeEventListener('abort',abort);abort();for(const frame of frames)frame.close()}
}
