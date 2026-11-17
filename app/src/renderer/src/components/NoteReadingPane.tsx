import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ArrowDown } from 'lucide-react'
import { t } from '../../../shared/i18n'
import { useFollowLatest } from '../useFollowLatest'
import { ScrollFade } from './ScrollFade'

export function NoteReadingPane({ active, summary, hasSummary, generating, writing, scroll, children }: {
  active: boolean; summary: boolean; hasSummary: boolean; generating: boolean; writing: boolean; scroll: RefObject<HTMLElement | null>; children: ReactNode
}) {
  const frame = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!active || !generating || !frame.current) { setVisible(false); return }
    let intersecting = false
    const sync = () => setVisible(intersecting && !document.hidden)
    const observer = new IntersectionObserver(([entry]) => { intersecting = entry.isIntersecting; sync() })
    observer.observe(frame.current)
    document.addEventListener('visibilitychange', sync)
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', sync) }
  }, [active, generating])
  const follow = useFollowLatest(scroll, content, active && generating && visible)
  useLayoutEffect(() => { if (writing) follow.resume() }, [writing])
  return <div ref={frame} className="note-reading-frame" hidden={!active} data-has-summary={summary && hasSummary} data-generating={generating} data-active={active && generating && visible}>
    <div className="note-reading-clip">
      <ScrollFade enabled={active}><section ref={scroll} id="note-notes-panel" role="tabpanel" aria-labelledby={summary ? 'note-summary-tab' : 'note-notes-tab'} className="note-content note-notes-pane">
        <div ref={content} className="note-page-width note-notes-body">{children}</div>
      </section></ScrollFade>
    </div>
    {writing && !follow.behind && <span className="note-summary-status" aria-hidden="true"><span className="summary-status-text">{t('Generating notes…')}</span></span>}
    {follow.behind && <button type="button" className="workspace-button note-latest" data-testid="note-summary-latest" onClick={follow.latest}><ArrowDown size={12} aria-hidden="true" />{t('Latest')}</button>}
  </div>
}
