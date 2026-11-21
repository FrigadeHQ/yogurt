import { createContext } from 'react'

// Home's Agenda and contextual Ask render into the same trailing workspace slot.
export const RightRegion = createContext<HTMLElement | null | undefined>(undefined)
