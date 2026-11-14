import type { ReactElement } from 'react'
import { motion, useReducedMotion } from '../motion'
import { ScrollFade as Fade } from '@animate-ui/react/primitives/effects/scroll-fade'

/** Fade only overflowing edges of the existing scroller; no extra layout or moving text. */
export function ScrollFade({ children, enabled = true, size = 20 }: { children: ReactElement; enabled?: boolean; size?: number }) {
  const reduced = useReducedMotion()
  return <Fade asChild enabled={enabled} size={size} shrink={0} blur={0} transition={{ duration: (reduced ? motion.micro : motion.base) / 1000, ease: motion.out }}>{children}</Fade>
}
