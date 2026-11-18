import { AudioReader, fail, text, u32, u64, view } from './read'
import type { EncodedAudio } from './mp3'
type Box = { type: string; data: number; end: number }
function boxes(b: Uint8Array, start = 0, end = b.length): Box[] {
  const found: Box[] = []
  while (start < end) {
    if (end - start < 8) fail()
    let size = u32(b,start), header = 8
    if (size === 1) { if (end - start < 16) fail(); size = u64(b,start+8); header = 16 }
    if (!size) size = end - start
    if (size < header || start + size > end) fail()
    found.push({ type: text(b,start+4,4), data:start+header, end:start+size }); start += size
  }
  return found
}
function child(b: Uint8Array, parent: Box, type: string): Box { return boxes(b,parent.data,parent.end).find(x=>x.type===type) ?? fail('format') }
function table(b: Uint8Array, box: Box, width: number) {
  const count = u32(b,box.data+4)
  if (box.data+8+count*width !== box.end) fail()
  return { count, at:box.data+8 }
}
function descriptor(b: Uint8Array, at: number, end: number): { tag: number; at: number; end: number } {
  const tag = b[at++]; let size = 0, complete = false
  for (let i=0;i<4&&at<end;i++) { const n=b[at++]; size=size*128+(n&127); if (!(n&128)) {complete=true;break} }
  if (!complete || at+size>end) fail()
  return { tag, at, end:at+size }
}
function audioConfig(b: Uint8Array, box: Box): Uint8Array {
  const es = descriptor(b,box.data+4,box.end)
  if (es.tag!==3 || es.at+3>es.end) fail('format')
  let at=es.at+3; const flags=b[es.at+2]
  if (flags&128) at+=2
  if (flags&64) at+=1+b[at]
  if (flags&32) at+=2
  const decoder=descriptor(b,at,es.end)
  if (decoder.tag!==4 || decoder.at+13>decoder.end) fail('format')
  const specific=descriptor(b,decoder.at+13,decoder.end)
  if (specific.tag!==5 || specific.end-specific.at<2 || specific.end-specific.at>64) fail('format')
  return b.slice(specific.at,specific.end)
}
// shortcut: one non-fragmented AAC track; add container variants when a supported recording app needs them.
export async function m4a(reader: AudioReader): Promise<EncodedAudio & { endSeconds?: number; durationMs: number }> {
  let at=0, moov:Uint8Array|undefined
  while(at<reader.source.size) {
    const h=await reader.read(at,Math.min(16,reader.source.size-at))
    let size=u32(h,0);const type=text(h,4,4), header=size===1?16:8
    if(size===1)size=u64(h,8)
    if(!size)size=reader.source.size-at
    if(size<header||at+size>reader.source.size)fail()
    if(type==='moof')fail('format')
    if(type==='moov'){if(moov)fail('format');moov=(await reader.read(at,size)).slice()}
    at+=size
  }
  const b=moov??fail('format'), root=boxes(b)[0], tracks=boxes(b,root.data,root.end).filter(x=>x.type==='trak')
  const audio=tracks.filter(track=>{const mdia=child(b,track,'mdia'), handler=child(b,mdia,'hdlr'), kind=text(b,handler.data+8,4);if(kind==='vide')fail('format');return kind==='soun'})
  if(audio.length!==1)fail('format')
  const track=audio[0],mdia=child(b,track,'mdia'),mdhd=child(b,mdia,'mdhd'),stbl=child(b,child(b,mdia,'minf'),'stbl')
  const timescale=u32(b,mdhd.data+(b[mdhd.data]===1?20:12))
  if(!timescale)fail()
  const stsd=child(b,stbl,'stsd')
  if(u32(b,stsd.data+4)!==1)fail('format')
  const entry=boxes(b,stsd.data+8,stsd.end)[0]
  if(entry.type!=='mp4a'||entry.data+28>entry.end)fail('format')
  const version=view(b).getUint16(entry.data+8)
  if(version>1)fail('format')
  const esds=boxes(b,entry.data+28+(version===1?16:0),entry.end).find(x=>x.type==='esds')??fail('format')
  const description=audioConfig(b,esds),object=description[0]>>3
  if(![2,5,29].includes(object))fail('format')
  const sampleRate=u32(b,entry.data+24)>>>16,numberOfChannels=view(b).getUint16(entry.data+16)
  if(sampleRate<8000||sampleRate>192000||numberOfChannels<1||numberOfChannels>8)fail('format')
  const sz=child(b,stbl,'stsz'),fixed=u32(b,sz.data+4),count=u32(b,sz.data+8)
  if(!count||count>4_000_000||sz.data+12+(fixed?0:count*4)!==sz.end)fail()
  const offsets=boxes(b,stbl.data,stbl.end).find(x=>x.type==='stco'||x.type==='co64')??fail('format'),wide=offsets.type==='co64',chunks=table(b,offsets,wide?8:4)
  const sc=table(b,child(b,stbl,'stsc'),12),ts=table(b,child(b,stbl,'stts'),8)
  if(!chunks.count||!sc.count||!ts.count||u32(b,sc.at)!==1)fail()
  for(let i=0;i<sc.count;i++) {
    const first=u32(b,sc.at+i*12)
    if(first>chunks.count||(i>0&&first<=u32(b,sc.at+(i-1)*12)))fail()
  }
  let trimSeconds=0,endSeconds:number|undefined
  const edts=boxes(b,track.data,track.end).find(x=>x.type==='edts')
  if(edts) {
    const elst=child(b,edts,'elst'),v=b[elst.data],n=u32(b,elst.data+4),start=elst.data+8
    if(n!==1||v>1)fail('format')
    const duration=v?u64(b,start):u32(b,start),media=v?Number(view(b).getBigInt64(start+8)):view(b).getInt32(start+4),rate=start+(v?16:8)
    if(media<0||view(b).getInt16(rate)!==1||view(b).getInt16(rate+2)!==0)fail('format')
    const mvhd=child(b,root,'mvhd'),movieScale=u32(b,mvhd.data+(b[mvhd.data]===1?20:12))
    if(!movieScale)fail()
    trimSeconds=media/timescale;endSeconds=trimSeconds+duration/movieScale
  }
  let ticks=0,samples=0
  for(let i=0;i<ts.count;i++){const n=u32(b,ts.at+i*8),delta=u32(b,ts.at+i*8+4);if(!n||!delta)fail();samples+=n;ticks+=n*delta}
  if(samples!==count||!Number.isSafeInteger(ticks))fail()
  const durationMs=((endSeconds??ticks/timescale)-trimSeconds)*1000
  if(durationMs<=0)fail()
  return {durationMs,config:{codec:`mp4a.40.${object}`,sampleRate,numberOfChannels,description},trimSeconds,endSeconds,packets:(async function*(){
    let index=0,run=0,timeRun=0,remaining=u32(b,ts.at),clock=0
    for(let chunk=1;chunk<=chunks.count;chunk++) {
      if(run+1<sc.count&&chunk===u32(b,sc.at+(run+1)*12))run++
      const entries=u32(b,sc.at+run*12+4),descriptionIndex=u32(b,sc.at+run*12+8)
      if(!entries||descriptionIndex!==1)fail('format')
      let offset=wide?u64(b,chunks.at+(chunk-1)*8):u32(b,chunks.at+(chunk-1)*4)
      for(let i=0;i<entries;i++) {
        if(index>=count)fail()
        while(!remaining){if(++timeRun>=ts.count)fail();remaining=u32(b,ts.at+timeRun*8)}
        const delta=u32(b,ts.at+timeRun*8+4),size=fixed||u32(b,sz.data+12+index*4)
        if(!delta||!size||size>1024**2)fail()
        const data=(await reader.read(offset,size)).slice()
        yield {data,timestamp:Math.round(clock*1e6/timescale),fraction:(index+1)/count}
        offset+=size;clock+=delta;index++;remaining--
      }
    }
    if(index!==count||remaining||timeRun!==ts.count-1)fail()
  })()}
}
