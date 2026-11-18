/** A reserved marker, never a person's name or a me/them attribution. */
export const AUDIO_SPEAKER = '\u001faudio'
export type AudioUploadFile = { token: string; name: string; title: string; modifiedAt: number; size: number }
export type AudioUploadStatus = {
  phase: 'reading' | 'preparing' | 'transcribing' | 'waiting-model' | 'waiting-recording' | 'cancelling' | 'done' | 'error'
  fraction?: number
  meetingId?: string
  error?: 'format' | 'read' | 'transcribe' | 'busy'
}
/** Date fields use local calendar days, not UTC's possibly adjacent day. */
export function uploadDate(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export function uploadStartedAt(value: string, original: number): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return
  const [year, month, day] = value.split('-').map(Number), at = new Date(original)
  at.setFullYear(year, month - 1, day)
  if (year < 1900 || uploadDate(+at) !== value) return
  return +at
}

export function uploadTime(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
/** Changing the date keeps the displayed local time; a time edit uses the chosen minute. */
export function uploadDateTime(date: string, time: string, original: number): number | undefined {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return
  const at = uploadStartedAt(date, original)
  if (at == null) return
  if (time === uploadTime(original)) return at
  const [hours, minutes] = time.split(':').map(Number), value = new Date(at)
  value.setHours(hours, minutes, 0, 0)
  return +value
}

export function uploadDayAllowed(at:number,now=Date.now()) {
  return Number.isFinite(at)&&new Date(at).getFullYear()>=1900&&new Date(at).setHours(0,0,0,0)<=new Date(now).setHours(0,0,0,0)
}
/** One clock field accepts the local day period and either local digits or ASCII. */
export function uploadClock(value:string,at:number,locale:string):number|undefined {
  let text=value.trim().toLocaleLowerCase(locale).replace(/[\u200e\u200f\u061c]/g,'').replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-0x660)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-0x6f0))
  for(let n=0;n<10;n++)text=text.replaceAll(new Intl.NumberFormat(locale,{useGrouping:false}).format(n),String(n))
  const periods=[0,12].map(hour=>new Intl.DateTimeFormat(locale,{hour:'numeric',hour12:true}).formatToParts(new Date(2026,0,1,hour)).find(p=>p.type==='dayPeriod')?.value.toLocaleLowerCase(locale))
  let half:number|undefined
  for(const [i,period] of periods.entries())if(period&&text.includes(period)){half=i; text=text.replace(period,'').trim();break}
  const match=/^(\d{1,2})\s*[:.：]\s*(\d{2})$/.exec(text)
  if(!match)return
  let hour=Number(match[1]);const minute=Number(match[2])
  if(minute>59||hour>23||half!=null&&(hour<1||hour>12))return
  if(half!=null)hour=hour%12+half*12
  const next=new Date(at);next.setHours(hour,minute,0,0)
  if(next.getHours()!==hour||next.getMinutes()!==minute)return
  return +next
}

/** Arrow edits wrap within the chosen day; a missing daylight-saving time stays unchanged. */
export function stepUploadClock(at:number,minutes:number):number {
  const date=new Date(at),total=(date.getHours()*60+date.getMinutes()+minutes+1440)%1440
  date.setHours(Math.floor(total/60),total%60,0,0)
  return date.getHours()*60+date.getMinutes()===total?+date:at
}
