import type { ComponentPropsWithoutRef } from 'react'
import { Check } from './Icons'

export function Checkbox(props: Omit<ComponentPropsWithoutRef<'input'>, 'type' | 'className'>) {
  return <span className="ui-checkbox">
    <input {...props} type="checkbox" />
    <Check size={12} aria-hidden="true" />
  </span>
}
