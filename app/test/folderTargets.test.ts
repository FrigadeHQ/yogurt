import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/renderer/src/workspace.css', import.meta.url), 'utf8')

it('gives opposite actions separate 24px targets in meeting rows', () => {
  const box = css.match(/\.meeting-folder-proposal \.workspace-icon\s*\{([^}]+)\}/)![1]
  const strip = css.match(/\.meeting-folder-proposal \.note-folder-actions\s*\{\s*width:(\d+)px/ )![1]
  for (const axis of ['width', 'height']) expect(Number(box.match(new RegExp(axis + ':(\\d+)px'))![1])).toBeGreaterThanOrEqual(24)
  expect(Number(strip)).toBeGreaterThanOrEqual(48)
})
