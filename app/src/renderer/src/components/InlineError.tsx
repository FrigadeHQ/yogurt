import { t } from '../../../shared/i18n'
import type { ReactNode } from 'react'

/** Keep recovery beside the affected content, without hiding the content that was kept. */
export function InlineError({ testId, className = '', children, retry }: {
  testId: string; className?: string; children?: ReactNode; retry?: () => void
}) {
  return <div data-testid={testId} data-state="failed" role="alert" className={`inline-error ${className}`}>
    {children ?? <span>{t("Couldn't load this content.")}</span>}
    {retry && <button type="button" className="workspace-button" onClick={retry}>{t('Try again')}</button>}
  </div>
}

/** Center recovery in the space that the missing content would occupy. */
export function ReadError({ testId, retry, className = '' }: {
  testId: string; retry: () => void; className?: string
}) {
  return <section data-testid={testId} role="alert" className={`empty-state read-error ${className}`}>
    <div className="empty-state-content">
      <p>{t("Couldn't load this content.")}</p>
      <button type="button" className="workspace-button" onClick={retry}>{t('Try again')}</button>
    </div>
  </section>
}
