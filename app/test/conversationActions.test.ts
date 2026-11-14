import { beforeEach, expect, it, vi } from 'vitest'
import { createElement, useState, type ComponentProps, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Menu } from '@base-ui/react/menu'
import { ConversationActions } from '../src/renderer/src/components/ConversationActions'

vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>()
  return { ...react, useState: vi.fn(react.useState) }
})
vi.mock('@base-ui/react/menu', () => {
  const children = ({ children }: { children?: ReactNode }) => children
  return { Menu: { Root: children, Trigger: children, Portal: children, Positioner: children, Popup: vi.fn(children), Item: vi.fn(children) } }
})
vi.mock('../src/renderer/src/components/Modal', () => ({
  Modal: () => { throw new Error('Recent owns the dialog; the menu must not render another') },
  ModalClose: () => null,
}))

beforeEach(() => vi.clearAllMocks())

it.each(['rename', 'delete'] as const)('hands focus to a %s dialog owned by Recent', kind => {
  let dialog: string | undefined
  vi.mocked(useState).mockImplementation(() => [dialog, next => { dialog = next as string }])
  const onEdit = vi.fn()
  const render = () => renderToStaticMarkup(createElement(ConversationActions, { id: 'chat', title: 'Weekly', onDeleted() {}, onEdit }))
  const popup = () => vi.mocked(Menu.Popup).mock.calls.at(-1)![0]
  render()
  // Ordinary menu dismissal still returns focus to its trigger.
  expect(popup().finalFocus).toEqual({ current: null })
  const item = vi.mocked(Menu.Item).mock.calls.map(([props]) => props as ComponentProps<typeof Menu.Item> & { 'data-testid': string })
    .find(props => props['data-testid'] === `chat-${kind}`)!
  item.onClick!({} as never)
  expect(onEdit).toHaveBeenCalledWith(kind)
  render()
  // Explicit trigger restoration runs after the menu's exit and would steal dialog focus.
  expect(popup().finalFocus).toBe(false)
})
