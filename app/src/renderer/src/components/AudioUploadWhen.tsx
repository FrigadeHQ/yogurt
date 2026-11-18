import {useEffect,useRef,useState} from 'react'
import {Popover} from '@base-ui/react/popover'
import {CalendarDays,ChevronLeft,ChevronRight} from 'lucide-react'
import {language,t} from '../../../shared/i18n'
import {noteDateLabel,timeOf} from '../../../shared/dates'
import {uploadClock,stepUploadClock,uploadDayAllowed} from '../../../shared/audioUpload'
import {weekDates,shiftDay} from '../agenda'

export function AudioUploadWhen({at,durationMs,onChange,disabled=false}:{at:number;durationMs:number;onChange:(at:number)=>void;disabled?:boolean}) {
  const [open,setOpen]=useState(false),row=useRef<HTMLDivElement>(null)
  const [month,setMonth]=useState(()=>new Date(at).setDate(1))
  const date=new Date(at),shown=new Date(month),today=new Date()
  const first=new Date(shown.getFullYear(),shown.getMonth(),1)
  const start=weekDates(+first)[0]
  const days=Array.from({length:42},(_,i)=>shiftDay(start,i))
  const nextMonth=(step:number)=>+new Date(shown.getFullYear(),shown.getMonth()+step,1)
  const monthName=(value:number)=>new Date(value).toLocaleDateString(language(),{month:'long',year:'numeric'})
  const choose=(day:number)=>{const next=new Date(at),picked=new Date(day);next.setFullYear(picked.getFullYear(),picked.getMonth(),picked.getDate());if(uploadDayAllowed(+next)){onChange(+next);setOpen(false)}}
  return <Popover.Root open={open&&!disabled} onOpenChange={value=>{setOpen(value);if(value)setMonth(new Date(at).setDate(1))}}>
    <div ref={row} className="audio-upload-date-row"><Popover.Trigger type="button" disabled={disabled} data-dialog-focus className="note-chip audio-upload-date" data-testid="audio-upload-date"><CalendarDays size={14}/><span>{noteDateLabel(at)}</span></Popover.Trigger><Clock at={at} onChange={onChange} disabled={disabled}/><small>{t('{count} min',{count:Math.ceil(durationMs/60000)})}</small></div>
    <Popover.Portal>
      <Popover.Positioner anchor={row} side="bottom" align="start" sideOffset={8} collisionPadding={12} collisionAvoidance={{side:'shift',align:'shift',fallbackAxisSide:'none'}} positionMethod="fixed" className="audio-upload-date-positioner">
        <Popover.Popup className="people-card menu-entry audio-upload-date-picker" data-testid="audio-upload-picker" aria-label={t('Date')} initialFocus={()=>document.querySelector<HTMLElement>('[data-upload-day][aria-pressed=true]')}>
          <div className="agenda-navigation"><span className="agenda-month" aria-live="polite">{monthName(month)}</span>
            <button type="button" className="ghost-btn workspace-icon" aria-label={monthName(nextMonth(-1))} disabled={shown.getFullYear()===1900&&shown.getMonth()===0} onClick={()=>setMonth(nextMonth(-1))}><ChevronLeft size={15} className="rtl:-scale-x-100"/></button>
            <button type="button" className="ghost-btn workspace-icon" aria-label={monthName(nextMonth(1))} disabled={nextMonth(1)>+today} onClick={()=>setMonth(nextMonth(1))}><ChevronRight size={15} className="rtl:-scale-x-100"/></button>
          </div>
          <div className="agenda-week audio-upload-month" aria-label={t('Date')}>
            {days.slice(0,7).map(day=><span key={day}>{new Date(day).toLocaleDateString(language(),{weekday:'narrow'})}</span>)}
            {days.map(day=>{const d=new Date(day);return <button key={day} type="button" data-upload-day={day} data-outside={d.getMonth()!==shown.getMonth()||undefined} disabled={!uploadDayAllowed(day)} aria-pressed={d.toDateString()===date.toDateString()} aria-label={d.toLocaleDateString(language(),{weekday:'long',month:'long',day:'numeric',year:'numeric'})} onClick={()=>choose(day)}><b>{d.toLocaleDateString(language(),{day:'numeric'})}</b></button>})}
          </div>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
}
function Clock({at,onChange,disabled}:{at:number;onChange:(at:number)=>void;disabled:boolean}) {
  const original=timeOf(at),[value,setValue]=useState(original)
  useEffect(()=>setValue(original),[original])
  const commit=()=>{const next=uploadClock(value,at,language());setValue(next==null?original:timeOf(next));if(next!=null)onChange(next)}
  return <input className="audio-upload-time" disabled={disabled} type="text" aria-label={t('Start time')} aria-keyshortcuts="ArrowUp ArrowDown Shift+ArrowUp Shift+ArrowDown" value={value} onChange={e=>setValue(e.target.value)} onFocus={e=>e.target.select()} onBlur={commit} onKeyDown={e=>{
    if(e.key==='Enter'){e.preventDefault();commit()}
    else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setValue(original);e.currentTarget.select()}
    else if(e.key==='ArrowUp'||e.key==='ArrowDown'){
      e.preventDefault()
      const next=stepUploadClock(uploadClock(value,at,language())??at,(e.key==='ArrowUp'?1:-1)*(e.shiftKey?60:1))
      setValue(timeOf(next));onChange(next)
    }
  }}/>
}
