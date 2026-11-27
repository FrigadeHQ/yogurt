import { expect, it } from 'vitest'
import { askOverDialogs } from '../src/shared/askContext'

it('opens Ask with nothing in the way, or only its own panel', () => {
  expect(askOverDialogs([])).toBe('ask')
  expect(askOverDialogs(['chat-panel'])).toBe('ask')
})

it('closes Keyboard shortcuts or Search first, so Ctrl+J still opens Ask (#175)', () => {
  expect(askOverDialogs(['shortcuts-dialog'])).toBe('dismiss')
  expect(askOverDialogs(['search'])).toBe('dismiss')
  expect(askOverDialogs(['chat-panel', 'shortcuts-dialog'])).toBe('dismiss')
})

it('leaves a question or form the person is answering alone', () => {
  expect(askOverDialogs(['delete-confirm'])).toBe('blocked')
  expect(askOverDialogs([undefined])).toBe('blocked')
  expect(askOverDialogs(['shortcuts-dialog', 'delete-confirm'])).toBe('blocked')
})
