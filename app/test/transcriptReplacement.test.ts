import {LOCALES} from '../src/shared/i18n'
import {expect,it} from 'vitest'
import {transcriptReplacement,previousSpeaker} from '../src/shared/transcriptReplacement'
import {uploadClock,uploadDayAllowed} from '../src/shared/audioUpload'
const line=(startMs:number,endMs:number,text:string,speaker:string|null='Alex')=>({meetingId:'sample',track:'them' as const,startMs,endMs,text,speaker})
it('dims the original, then writes the staged prefix over only the reached time range',()=>{
 const old=[line(0,100,'Old beginning'),line(100,200,'Old ending')],draft=[line(0,110,'New beginning')]
 expect(transcriptReplacement(old,[]).every(l=>l.previous)).toBe(true)
 expect(transcriptReplacement(old,draft).map(l=>l.text)).toEqual(['New beginning'])
 expect(transcriptReplacement(old,[line(0,80,'New beginning')]).map(l=>[l.text,!!l.previous])).toEqual([['New beginning',false],['Old ending',true]])
 expect(old[0].text).toBe('Old beginning')
})
it('keeps a previous speaker only across agreeing overlaps on that track',()=>{
 const old=[line(0,100,'One'),line(100,200,'Two','Jamie')]
 expect(previousSpeaker(old,'them',10,90)).toBe('Alex');expect(previousSpeaker(old,'them',50,150)).toBeNull();expect(previousSpeaker(old,'me',0,100)).toBeNull()
})
it('accepts a single localized clock field and rejects invalid clocks or future dates',()=>{
 const at=+new Date(2026,10,17,10,30)
 expect(new Date(uploadClock('2:45 PM',at,'en')!).getHours()).toBe(14)
 expect(new Date(uploadClock('14:45',at,'de')!).getMinutes()).toBe(45)
 expect(new Date(uploadClock('٢:٤٥ م',at,'ar')!).getHours()).toBe(14)
 expect(uploadClock('25:99',at,'en')).toBeUndefined();expect(uploadClock('13:00 PM',at,'en')).toBeUndefined()
 expect(uploadDayAllowed(+new Date(10000,0,1),at)).toBe(false);expect(uploadDayAllowed(at,at)).toBe(true);expect(uploadDayAllowed(+new Date(2026,10,18),at)).toBe(false)
})

it('round trips the displayed clock in every app locale',()=>{
 const at=+new Date(2026,10,17,14,45)
 for(const {id} of LOCALES){const value=new Intl.DateTimeFormat(id,{hour:'numeric',minute:'2-digit'}).format(at);expect(uploadClock(value,at,id),id+' '+value).toBe(at)}
})
