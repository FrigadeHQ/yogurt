import { useLayoutEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from './motion'

/** Fast local reads stay invisible; a skeleton that has appeared gets time to be read. */
export function useLoadingState(pending: boolean) {
  const reduced = useReducedMotion()
  const [phase, setPhase] = useState<'waiting' | 'skeleton' | 'revealing' | 'ready'>(pending ? 'waiting' : 'ready')
  const shownAt = useRef<number | undefined>(undefined)
  useLayoutEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    if (pending) {
      if (phase !== 'skeleton') {
        shownAt.current = undefined
        setPhase('waiting')
        timer = setTimeout(() => { shownAt.current = performance.now(); setPhase('skeleton') }, 100)
      }
    } else if (phase === 'waiting') setPhase('ready')
    else if (phase === 'skeleton') {
      if (reduced) setPhase('revealing')
      else timer = setTimeout(() => setPhase('revealing'), Math.max(0, 200 - (performance.now() - shownAt.current!)))
    } else if (phase === 'revealing') {
      timer = setTimeout(() => setPhase('ready'), motion.micro)
    }
    return () => clearTimeout(timer)
  }, [pending, phase, reduced])
  return phase
}
