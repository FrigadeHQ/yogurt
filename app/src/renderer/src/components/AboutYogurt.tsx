import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { Check, Share } from 'lucide-react'
import { t } from '../../../shared/i18n'
import { projectRepository, projectWebsite } from '../../../shared/project'
import githubBlack from '../assets/github-black.svg?no-inline'
import githubWhite from '../assets/github-white.svg?no-inline'
import { onMac } from '../keys'
import { Copy } from './Icons'
import { Swap, SwapText } from './Swap'

export function AboutYogurt() {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<'copy' | 'share' | null>(null)
  const attempt = useRef(0)
  const idle = t('Copy link'), done = t('Copied')
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(timer)
  }, [copied])

  async function copy() {
    const current = ++attempt.current
    try {
      await navigator.clipboard.writeText(projectWebsite)
      if (current !== attempt.current) return
      setError(null)
      setCopied(true)
    } catch {
      if (current !== attempt.current) return
      setCopied(false)
      setError('copy')
    }
  }

  async function share(event: MouseEvent<HTMLButtonElement>) {
    const current = ++attempt.current
    const { left, bottom } = event.currentTarget.getBoundingClientRect()
    const opened = await window.yogurt.share.appLink(left, bottom).catch(() => false)
    if (current === attempt.current) setError(opened ? null : 'share')
  }

  const message = error === 'copy' ? t("Yogurt couldn't copy.") : error === 'share' ? t("Yogurt couldn't open the share menu.") : ''
  return <section aria-labelledby="about-yogurt">
    <h2 id="about-yogurt" className="settings-section-heading">{t('About Yogurt')}</h2>
    <div className="settings-group settings-backup">
      <p className="settings-label grid">
        <span className={`col-start-1 row-start-1 ${error ? 'invisible' : ''}`}>{t('Like Yogurt? Sharing it or starring it on GitHub helps us keep building it.')}</span>
        <span role="status" className={error ? 'col-start-1 row-start-1 text-danger' : 'sr-only'}>{message || (copied ? done : '')}</span>
      </p>
      <div className="settings-backup-actions settings-about-actions">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="workspace-button" aria-label={copied ? done : idle} onClick={copy}>
            <Swap show={copied ? 'done' : 'copy'} options={{ copy: <Copy size={13}/>, done: <Check size={13}/> }}/>
            <SwapText text={copied ? done : idle} widest={copied ? idle : done}/>
          </button>
          {onMac() && <button type="button" className="workspace-button" aria-haspopup="menu" onClick={share}>
            <Share size={14} strokeWidth={1.75} aria-hidden="true"/>{t('Share…')}
          </button>}
        </div>
        <a className="workspace-button" href={projectRepository} target="_blank" rel="noopener noreferrer">
          <picture className="shrink-0"><source media="(prefers-color-scheme: dark)" srcSet={githubWhite}/>
            <img src={githubBlack} width={20} height={20} alt=""/></picture>{t('View on GitHub')}
        </a>
      </div>
    </div>
  </section>
}
