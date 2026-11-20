import {useEffect,useRef,useState} from 'react'
import {Popover} from '@base-ui/react/popover'
import {CalendarDays,ChevronLeft,ChevronRight} from 'lucide-react'
import {language,t} from '../../../shared/i18n'
import {noteDateLabel} from '../../../shared/dates'
import {uploadDate,uploadDateTime,uploadTime,uploadDayAllowed,stepUploadClock} from '../../../shared/audioUpload'
import {weekDates,shiftDay} from '../agenda'

export function AudioUploadWhen({at,durationMs,onChange,disabled=false}:{at:number;durationMs:number;onChange:(at:number)=>void;disabled?:boolean}) {
  const [open,setOpen]=useState(false),row=useRef<HTMLDivElement>(null)
  const [invalid, setInvalid] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const time = uploadTime(at)
  useEffect(() => {
    if (input.current?.validity.customError) return
    if (input.current) input.current.value = time
    setInvalid(false)
  }, [time])
  const validate = (field: HTMLInputElement, showError: boolean) => {
    const next = uploadDateTime(uploadDate(at), field.value, at)
    field.setCustomValidity(next === undefined ? t('Enter a valid start time.') : '')
    setInvalid(next === undefined && showError)
    return next
  }
  const [month,setMonth]=useState(()=>new Date(at).setDate(1))
  const date=new Date(at),shown=new Date(month),today=new Date()
  const first=new Date(shown.getFullYear(),shown.getMonth(),1)
  const start=weekDates(+first)[0]
  const days=Array.from({length:42},(_,i)=>shiftDay(start,i))
  const nextMonth=(step:number)=>+new Date(shown.getFullYear(),shown.getMonth()+step,1)
  const monthName=(value:number)=>new Date(value).toLocaleDateString(language(),{month:'long',year:'numeric'})
  const choose = (day: number) => {
    if (!uploadDayAllowed(day)) return
    const field = input.current
    const next = uploadDateTime(uploadDate(day), field?.value ?? time, at)
    if (field) {
      field.setCustomValidity(next === undefined ? t('Enter a valid start time.') : '')
      setInvalid(next === undefined)
    }
    // An incomplete or nonexistent local time must be corrected before the date can be submitted.
    onChange(next ?? day)
    setOpen(false)
  }
  return <Popover.Root open={open&&!disabled} onOpenChange={value=>{setOpen(value);if(value)setMonth(new Date(at).setDate(1))}}>
    <div ref={row} className="audio-upload-date-row"><Popover.Trigger type="button" disabled={disabled} data-dialog-focus className="note-chip audio-upload-date" data-testid="audio-upload-date"><CalendarDays size={14}/><span>{noteDateLabel(at)}</span></Popover.Trigger><input id="upload-start-time" ref={input} className="audio-upload-time" type="time" required disabled={disabled}
      aria-label={t('Start time')} defaultValue={time} aria-invalid={invalid || undefined} aria-describedby={invalid ? 'upload-time-error' : undefined}
      onChange={e => { const next = validate(e.currentTarget, invalid); if (next !== undefined && next !== at) onChange(next) }}
      onBlur={e => validate(e.currentTarget, true)} onInvalid={e => { e.preventDefault(); setInvalid(true); e.currentTarget.focus() }}
      onKeyDown={e => {
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation()
          e.currentTarget.value = time; validate(e.currentTarget, false)
        } else if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.currentTarget.validity.valid) {
          e.preventDefault()
          onChange(stepUploadClock(at, e.key === 'ArrowUp' ? 60 : -60))
        }
      }}
    /><small>{t('{count} min',{count:Math.ceil(durationMs/60000)})}</small></div>
    {invalid && <span id="upload-time-error" role="alert" className="upload-time-error">{t('Enter a valid start time.')}</span>}
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
