import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { toastClearance } from '../src/renderer/src/components/TrashToast'

it('keeps one window anchor for a live toast across workspace routes, panel widths, sidebar states and reduced motion', () => {
  const css = ['styles.css', 'workspace.css'].map(file =>
    readFileSync(new URL(`../src/renderer/src/${file}`, import.meta.url), 'utf8')).join('\n')
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*\.app-toast-viewport[^{}]*)\{([^{}]*)\}/g)]
  // Any second selector could move the very same portal as the DOM or a media query changes.
  expect(rules.map(rule => rule[1].trim())).toEqual(['.app-toast-viewport'])
  expect(rules[0][2]).toMatch(/position:\s*fixed;/)
  expect(rules[0][2]).toMatch(/bottom:\s*20px;/)
  expect(rules[0][2]).toMatch(/inset-inline-end:\s*20px;/)
  expect(rules[0][2]).not.toMatch(/(?:translate|transform):/)
})

it('reserves the measured stack for docked controls, including two wrapped cards at high zoom', () => {
  expect(toastClearance([])).toBe('')
  expect(toastClearance([{ height: 54 }])).toBe('calc(86px + 0rem)')
  expect(toastClearance([{ height: 70 }, { height: 89 }, { height: 54, limited: true }])).toBe('calc(191px + 0.75rem)')
  expect(toastClearance([{ height: 54, limited: true }])).toBe('')
})
