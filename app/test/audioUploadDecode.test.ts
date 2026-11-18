import { inspectAudioUpload } from '../src/preload/audioUpload/inspect'
import { expect, it, vi } from 'vitest'
import { AudioResampler } from '../src/preload/audioUpload/resample'
import { AudioReader, type AudioSource } from '../src/preload/audioUpload/read'
import { decodeAudioUpload } from '../src/preload/audioUpload/decode'
import { mp3, mp3Header } from '../src/preload/audioUpload/mp3'
import { m4a } from '../src/preload/audioUpload/m4a'
import { wavBytes } from '../src/main/asr/transcribe'
const source=(bytes:Uint8Array):AudioSource=>({size:bytes.length,read:async(at,n)=>bytes.slice(at,at+n)})
const reader=(b:Uint8Array)=>new AudioReader(source(b),new AbortController().signal)
const words=(...values:number[])=>{const b=Buffer.alloc(values.length*4);values.forEach((n,i)=>b.writeUInt32BE(n,i*4));return b}
const box=(type:string,...body:Uint8Array[])=>{const bytes=Buffer.concat(body);return Buffer.concat([words(bytes.length+8),Buffer.from(type),bytes])}
const full=(...body:Uint8Array[])=>Buffer.concat([words(0),...body])
const desc=(tag:number,data:Uint8Array)=>Buffer.concat([Buffer.from([tag,data.length]),data])
function aacFile(handler='soun') {
 const ftyp=box('ftyp',Buffer.from('M4A '),words(0),Buffer.from('isom')),mdat=box('mdat',Buffer.from([1,2,3,4,5,6,7]))
 const config=desc(3,Buffer.concat([Buffer.from([0,1,0]),desc(4,Buffer.concat([Buffer.alloc(13),desc(5,Buffer.from([0x12,0x10]))]))]))
 const entry=Buffer.alloc(28);entry.writeUInt16BE(2,16);entry.writeUInt16BE(16,18);entry.writeUInt32BE(44100*65536,24)
 const stbl=box('stbl',box('stsd',full(words(1),box('mp4a',entry,box('esds',full(config))))),box('stsz',full(words(0,2,3,4))),box('stco',full(words(1,ftyp.length+8))),box('stsc',full(words(1,1,2,1))),box('stts',full(words(1,2,1024))))
 return Buffer.concat([ftyp,mdat,box('moov',box('mvhd',full(words(0,0,1000,47))),box('trak',box('mdia',box('mdhd',full(words(0,0,44100,2048))),box('hdlr',full(words(0),Buffer.from(handler),Buffer.alloc(12))),box('minf',stbl))))])
}
it('reads AAC config, chunk offsets, individual sample sizes and timestamps from M4A',async()=>{
 const audio=await m4a(reader(aacFile()));expect(audio.config).toMatchObject({codec:'mp4a.40.2',sampleRate:44100,numberOfChannels:2})
 expect(Array.from(new Uint8Array(audio.config.description as Uint8Array))).toEqual([0x12,0x10])
 const packets=[];for await(const p of audio.packets)packets.push(p)
 expect(packets.map(p=>Array.from(p.data))).toEqual([[1,2,3],[4,5,6,7]])
 expect(packets.map(p=>p.timestamp)).toEqual([0,23220]);expect(packets.at(-1)?.fraction).toBe(1)
})
it('rejects video containers, fragmented files, and malformed M4A tables',async()=>{
 await expect(m4a(reader(aacFile('vide')))).rejects.toThrow()
 await expect(m4a(reader(Buffer.concat([aacFile(),box('moof')])))).rejects.toThrow()
 const corrupt=aacFile();const at=corrupt.indexOf('stsz')+12;corrupt.writeUInt32BE(0xffffffff,at)
 await expect(m4a(reader(corrupt))).rejects.toThrow()
 const badChunk=aacFile();badChunk.writeUInt32BE(2,badChunk.indexOf('stsc')+12);await expect(m4a(reader(badChunk))).rejects.toThrow()
})
it('handles variable bitrate MP3 frames and skips ID3 metadata without reading the whole file',async()=>{
 const headers=[Buffer.from([255,251,144,0]),Buffer.from([255,251,160,0])]
 const frames=headers.map(h=>{const b=Buffer.alloc(mp3Header(h).length);b.set(h);return b})
 const id3=Buffer.from([73,68,51,4,0,0,0,0,0,3,0,0,0]),audio=await mp3(reader(Buffer.concat([id3,...frames])))
 expect(audio.config).toEqual({codec:'mp3',sampleRate:44100,numberOfChannels:2})
 const result=[];for await(const p of audio.packets)result.push(p)
 expect(result.map(p=>p.data.length)).toEqual(frames.map(f=>f.length));expect(result[1].timestamp).toBe(26122)
})
it('rejects truncated MP3 frames and unsupported free-bitrate headers',async()=>{
 expect(()=>mp3Header(Buffer.from([255,251,0,0]))).toThrow()
 const audio=await mp3(reader(Buffer.concat([Buffer.from([255,251,144,0]),Buffer.alloc(20)])))
 await expect(audio.packets[Symbol.asyncIterator]().next()).rejects.toThrow()
})
it('decodes PCM WAV in bounded chunks, downmixes and preserves sample time',async()=>{
 const bytes=wavBytes(Float32Array.from({length:32001},(_,i)=>.25*Math.sin(i/8)))
 const chunks:Float32Array[]=[];await decodeAudioUpload(source(bytes),async p=>{chunks.push(p)},new AbortController().signal)
 expect(chunks.reduce((n,c)=>n+c.length,0)).toBe(32001);expect(Math.max(...chunks.map(c=>c.length))).toBeLessThanOrEqual(8192)
 expect(chunks[1].every(Number.isFinite)).toBe(true)
 const stereo=Buffer.alloc(44+8);wavBytes(new Float32Array(4)).copy(stereo,0,0,44);stereo.writeUInt16LE(2,22);stereo.writeUInt16LE(4,32);stereo.writeUInt32LE(64000,28)
 stereo.writeInt16LE(16384,44);stereo.writeInt16LE(-16384,46);stereo.writeInt16LE(16384,48);stereo.writeInt16LE(-16384,50)
 let heard:Float32Array|undefined;await decodeAudioUpload(source(stereo),async p=>{heard=p},new AbortController().signal);expect([...heard!]).toEqual([0,0])
})
it('starts a three-hour WAV with bounded reads and cancels without decoding the remaining hours',async()=>{
 const dataBytes=16000*2*3*3600,header=wavBytes(new Float32Array(0));header.writeUInt32LE(36+dataBytes,4);header.writeUInt32LE(dataBytes,40)
 const sizes:number[]=[],abort=new AbortController()
 const long:AudioSource={size:dataBytes+44,read:async(at,n)=>{sizes.push(n);const b=new Uint8Array(n);if(at<header.length)b.set(header.subarray(at,Math.min(header.length,at+n)));return b}}
 let samples=0
 await expect(decodeAudioUpload(long,async p=>{samples+=p.length;abort.abort()},abort.signal)).rejects.toThrow()
 expect(samples).toBeGreaterThan(0);expect(samples).toBeLessThan(16000);expect(Math.max(...sizes)).toBeLessThanOrEqual(1024**2);expect(sizes.reduce((a,b)=>a+b,0)).toBeLessThan(2*1024**2)
})
it('rejects corrupt WAV payloads and nonfinite floating samples',async()=>{
 const b=wavBytes(new Float32Array(30));await expect(decodeAudioUpload(source(b.subarray(0,b.length-1)),async()=>{},new AbortController().signal)).rejects.toThrow()
 const bad=Buffer.alloc(48);wavBytes(new Float32Array(2)).copy(bad,0,0,44);bad.writeUInt16LE(3,20);bad.writeUInt16LE(32,34);bad.writeUInt16LE(4,32);bad.writeFloatLE(NaN,44)
 await expect(decodeAudioUpload(source(bad),async()=>{},new AbortController().signal)).rejects.toThrow()
})
it('resamples identically across arbitrary chunk boundaries and rejects above-band energy',()=>{
 const n=48000,input=Float32Array.from({length:n},(_,i)=>Math.sin(2*Math.PI*1000*i/48000))
 const full=new AudioResampler(48000).push(input,true),stream=new AudioResampler(48000),pieces:Float32Array[]=[]
 for(let at=0;at<input.length;at+=917)pieces.push(stream.push(input.subarray(at,at+917)))
 pieces.push(stream.push(new Float32Array(0),true));const result=Float32Array.from(pieces.flatMap(p=>Array.from(p)))
 expect(result).toEqual(full);expect(result).toHaveLength(16000)
 const high=new AudioResampler(48000).push(Float32Array.from({length:n},(_,i)=>Math.sin(2*Math.PI*14000*i/48000)),true)
 const rms=(a:Float32Array)=>Math.sqrt(a.slice(100,-100).reduce((sum,v)=>sum+v*v,0)/(a.length-200))
 expect(rms(full)).toBeGreaterThan(.65);expect(rms(high)).toBeLessThan(.02)
})
it('keeps the exact output duration at 44.1kHz without accumulating block-rounding drift',()=>{
 const r=new AudioResampler(44100);let frames=0
 for(let i=0;i<101;i++)frames+=r.push(new Float32Array(441)).length
 frames+=r.push(new Float32Array(0),true).length
 expect(frames).toBe(16160)
})

it('accepts extensible PCM only with the actual PCM subtype GUID', async () => {
 const plain=wavBytes(new Float32Array(100)),ext=Buffer.alloc(plain.length+24)
 plain.copy(ext,0,0,36);ext.writeUInt32LE(ext.length-8,4);ext.writeUInt32LE(40,16);ext.writeUInt16LE(65534,20)
 ext.writeUInt16LE(22,36);ext.writeUInt16LE(16,38);ext.writeUInt32LE(1,40)
 ext.set([1,0,0,0,0,0,16,0,128,0,0,170,0,56,155,113],44);plain.copy(ext,60,36)
 let count=0;await decodeAudioUpload(source(ext),async p=>{count+=p.length},new AbortController().signal);expect(count).toBe(100)
 ext[59]=0
 await expect(decodeAudioUpload(source(ext),async()=>{},new AbortController().signal)).rejects.toThrow()
})

it('reads WAV length from its header without walking through hours of samples', async () => {
 const dataBytes=16000*2*3*3600,header=wavBytes(new Float32Array(0));header.writeUInt32LE(36+dataBytes,4);header.writeUInt32LE(dataBytes,40)
 let read=0
 const file:AudioSource={size:dataBytes+44,read:async(at,n)=>{read+=n;const b=new Uint8Array(n);if(at<header.length)b.set(header.subarray(at,Math.min(header.length,at+n)));return b}}
 expect(await inspectAudioUpload(file,new AbortController().signal)).toBe(3*3600*1000)
 expect(read).toBeLessThanOrEqual(1024**2)
})
it('reads M4A length from sample timing tables without decoding its payload', async () => {
 expect(await inspectAudioUpload(source(aacFile()),new AbortController().signal)).toBeCloseTo(2048/44100*1000)
})
it('reads Xing and VBRI frame counts, or scans VBR frame headers when neither exists', async () => {
 const h=Buffer.from([255,251,144,0]),length=mp3Header(h).length
 const xing=Buffer.alloc(length*1000);xing.set(h);xing.write('Xing',36);xing.writeUInt32BE(1,40);xing.writeUInt32BE(1000,44)
 expect(await inspectAudioUpload(source(xing),new AbortController().signal)).toBeCloseTo(1000*1152/44100*1000)
 await expect(inspectAudioUpload(source(xing.subarray(0,length)),new AbortController().signal)).rejects.toThrow()
 const vbri=Buffer.alloc(length*2000);vbri.set(h);vbri.write('VBRI',36);vbri.writeUInt32BE(2000,50)
 expect(await inspectAudioUpload(source(vbri),new AbortController().signal)).toBeCloseTo(2000*1152/44100*1000)
 const frames=[h,Buffer.from([255,251,160,0])].map(h=>{const b=Buffer.alloc(mp3Header(h).length);b.set(h);return b})
 expect(await inspectAudioUpload(source(Buffer.concat(frames)),new AbortController().signal)).toBeCloseTo(2*1152/44100*1000)
 await expect(inspectAudioUpload(source(Buffer.concat(frames).subarray(0,-1)),new AbortController().signal)).rejects.toThrow()
})
it('cancels metadata inspection and rejects empty or corrupt files instead of inventing a length', async () => {
 const abort=new AbortController();abort.abort()
 await expect(inspectAudioUpload(source(aacFile()),abort.signal)).rejects.toThrow()
 await expect(inspectAudioUpload(source(wavBytes(new Float32Array(0))),new AbortController().signal)).rejects.toThrow()
})
it('interrupts a long MP3 header scan between bounded reads', async () => {
 const h=Buffer.from([255,251,144,0]),size=mp3Header(h).length,bytes=Buffer.alloc(size*6000)
 for(let at=0;at<bytes.length;at+=size)bytes.set(h,at)
 const abort=new AbortController();let reads=0
 const file:AudioSource={size:bytes.length,read:async(at,n)=>{if(++reads===2)abort.abort();return bytes.subarray(at,at+n)}}
 await expect(inspectAudioUpload(file,abort.signal)).rejects.toThrow()
 expect(reads).toBe(2)
})

it('batches decoded frames without losing samples or exceeding the main write limit',async()=>{
 const h=Buffer.from([255,251,144,0]),length=mp3Header(h).length,bytes=Buffer.alloc(length*128)
 for(let at=0;at<bytes.length;at+=length)bytes.set(h,at)
 class Decoder {
  static async isConfigSupported(){return{supported:true}}
  state='configured';constructor(private callbacks:{output:(frame:unknown)=>void}){}
  configure(){};close(){this.state='closed'};async flush(){}
  decode(packet:{timestamp:number}){this.callbacks.output({timestamp:packet.timestamp,sampleRate:44100,numberOfChannels:1,numberOfFrames:1152,copyTo:(plane:Float32Array)=>plane.fill(.25),close(){}})}
 }
 vi.stubGlobal('AudioDecoder',Decoder);vi.stubGlobal('EncodedAudioChunk',class{timestamp:number;constructor(p:{timestamp:number}){this.timestamp=p.timestamp}})
 try{const chunks:Float32Array[]=[];await decodeAudioUpload(source(bytes),async p=>{chunks.push(p.slice())},new AbortController().signal)
 expect(chunks.length).toBeLessThan(5);expect(chunks.reduce((n,p)=>n+p.length,0)).toBe(Math.floor(128*1152*16000/44100));expect(chunks.every(p=>p.length<=65536&&p.every(Number.isFinite))).toBe(true)
 }finally{vi.unstubAllGlobals()}
})
