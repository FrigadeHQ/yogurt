import { AudioReader, fail, text, u32 } from './read'
export type AudioPacket = { data: Uint8Array; timestamp: number; fraction: number }
export type EncodedAudio = { config: AudioDecoderConfig; packets: AsyncIterable<AudioPacket>; trimSeconds?: number }
const rates = [44100, 48000, 32000]
const high = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]
const low = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160]
export function mp3Header(b: Uint8Array) {
  if (b.length < 4 || b[0] !== 255 || (b[1] & 224) !== 224 || ((b[1] >> 1) & 3) !== 1) return fail('format')
  const version = (b[1] >> 3) & 3, rateIndex = (b[2] >> 2) & 3, bitrateIndex = b[2] >> 4
  if (version === 1 || rateIndex === 3 || !bitrateIndex || bitrateIndex === 15) return fail('format')
  const sampleRate = rates[rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4)
  const length = Math.floor((version === 3 ? 144000 : 72000) * (version === 3 ? high : low)[bitrateIndex] / sampleRate) + ((b[2] >> 1) & 1)
  return { sampleRate, numberOfChannels: (b[3] >> 6) === 3 ? 1 : 2, length, samples: version === 3 ? 1152 : 576 }
}
async function firstFrame(reader: AudioReader) {
  let at = 0
  const first = await reader.read(0, 10)
  if (text(first, 0, 3) === 'ID3') {
    if (first.slice(6,10).some(x => x > 127)) fail()
    at = 10 + first.slice(6,10).reduce((n,x) => n * 128 + x, 0) + ((first[5] & 16) ? 10 : 0)
  }
  const header = mp3Header(await reader.read(at, 4))
  return {at,header}
}
export async function mp3(reader: AudioReader): Promise<EncodedAudio> {
  let {at,header}=await firstFrame(reader)
  return { config: { codec: 'mp3', sampleRate: header.sampleRate, numberOfChannels: header.numberOfChannels }, packets: (async function* () {
    let samples = 0
    while (at < reader.source.size) {
      const left = reader.source.size - at
      const b = await reader.read(at, Math.min(8, left))
      if ((left === 128 && text(b,0,3) === 'TAG') || text(b,0,8) === 'APETAGEX') break
      const h = mp3Header(b)
      if (h.sampleRate !== header.sampleRate || h.numberOfChannels !== header.numberOfChannels) fail('format')
      const data = (await reader.read(at, h.length)).slice()
      at += h.length
      yield { data, timestamp: Math.round(samples * 1e6 / h.sampleRate), fraction: at / reader.source.size }
      samples += h.samples
    }
  })() }
}

/** Prefer frame counts in Xing/VBRI; otherwise count frame headers without decoding samples. */
export async function mp3Duration(reader: AudioReader): Promise<number> {
  let {at,header}=await firstFrame(reader)
  const first=await reader.read(at,header.length),version=(first[1]>>3)&3
  const side=version===3?(header.numberOfChannels===1?17:32):(header.numberOfChannels===1?9:17)
  const xing=4+((first[1]&1)?0:2)+side
  let frames=0
  if(first.length>=xing+12&&['Xing','Info'].includes(text(first,xing,4))&&(u32(first,xing+4)&1))frames=u32(first,xing+8)
  else if(first.length>=54&&text(first,36,4)==='VBRI')frames=u32(first,50)
  if(frames>0){
    const minimum=Math.floor((version===3?144000*32:72000*8)/header.sampleRate)
    if(frames*minimum>reader.source.size-at)fail()
    return frames*header.samples/header.sampleRate*1000
  }
  while(at<reader.source.size){
    const left=reader.source.size-at,b=await reader.read(at,Math.min(8,left))
    if((left===128&&text(b,0,3)==='TAG')||text(b,0,8)==='APETAGEX')break
    const h=mp3Header(b)
    if(h.sampleRate!==header.sampleRate||h.numberOfChannels!==header.numberOfChannels||at+h.length>reader.source.size)fail()
    at+=h.length;frames++
  }
  return frames*header.samples/header.sampleRate*1000
}
