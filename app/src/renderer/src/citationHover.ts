import { motion } from './motion'

/** One exit path for plain text and another citation; the next card never keeps the previous one open. */
export function citationHover(d: {
  state: () => { open: boolean; pinned: string | null; triggerId: string | null }
  show: (id: string) => void
  close: () => void
  valid: (id: string) => boolean
  resuming: (id: string) => boolean
}) {
  let timer: ReturnType<typeof setTimeout> | undefined, last = '', warmUntil = 0
  const cancel = (cold = false) => { clearTimeout(timer); timer = undefined; if (cold) warmUntil = 0 }
  const show = (id: string) => { last = id; warmUntil = performance.now() + 1000; d.show(id) }
  return {
    cancel,
    move(id: string | null, adjacent = false) {
      cancel()
      const state = d.state()
      if (state.pinned) return
      if (state.open && state.triggerId === id) return
      if (state.open) d.close()
      if (!id) return
      if (d.resuming(id)) { d.show(id); return }
      const warm = adjacent && last && performance.now() < warmUntil
      // The warm delay outlasts the 150 ms exit, so two sources never overlap.
      timer = setTimeout(() => { timer = undefined; if (d.valid(id)) show(id) }, warm ? motion.base : 600)
    },
  }
}
