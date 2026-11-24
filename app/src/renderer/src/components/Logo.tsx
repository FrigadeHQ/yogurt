import tile from '../../../../build/icons/128x128.png'
import { MARK, MARK_FIT, WORD } from '../../../shared/logo'

/** The Yogurt mark. */
export function Logo({ size = 28, className = 'text-accent' }: { size?: number; className?: string }) {
  return (
    <svg data-testid="logo" role="img" aria-label="Yogurt" width={size} height={size} viewBox="0 0 100 100" className={`shrink-0 ${className}`}>
      <path fill="currentColor" fillRule="evenodd" transform={MARK_FIT} d={MARK} />
    </svg>
  )
}

/** The mark with the name next to it, as on the website. Sized by its height. */
export function Wordmark({ height = 32 }: { height?: number }) {
  return (
    <svg data-testid="wordmark" role="img" aria-label="Yogurt" height={height} width={height * 786.465752994 / 177.905} viewBox="0 0 786.465752994 177.905" fillRule="evenodd" className="shrink-0">
      <path fill="var(--accent)" transform="translate(-24.470906765 -0.0254777349527) scale(0.470594360865)" d={MARK} />
      <path className="fill-[#1C1C1E] dark:fill-[#F2F2F3]" transform="translate(209.465752994 0.905) scale(1)" d={WORD} />
    </svg>
  )
}

/** The app tile used by the call prompt and its onboarding illustration. */
export function AppIcon({ className }: { className: string }) {
  return <picture className={className}>
    <source media="(prefers-color-scheme: dark)" srcSet="./prompt-icon-dark.png" />
    <img src={tile} alt="" className="size-full" />
  </picture>
}
