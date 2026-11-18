import {useEffect, useRef} from 'react'
import {ShareMenu} from '@app/components/ShareMenu'
import {meeting} from './bridge.mjs'

// The frame is inert. Open the real menu once so its labels follow the installed renderer.
export function CopyScene() {
  const stage = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const button = stage.current?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
    if (button?.getAttribute('aria-expanded') === 'false') button.click()
  }, [])
  return <div className="copy-stage" ref={stage}>
    <ShareMenu id={meeting.id} shown="enhanced" status="done" hasEnhanced beforeUse={async () => true} />
  </div>
}
