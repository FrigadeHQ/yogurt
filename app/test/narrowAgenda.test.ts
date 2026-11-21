import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/renderer/src/workspace.css', import.meta.url), 'utf8')

it('scrolls the agenda header and events together within the narrow grid row', () => {
  const narrow = css.slice(css.indexOf('@container (max-width:520px)')).split(/^}/m)[0]
  expect(narrow).toMatch(/\.native-agenda\s*\{[^}]*overflow-y:\s*auto/)
  expect(narrow).toMatch(/\.agenda-scroll\s*\{[^}]*overflow:\s*visible/)
})

it('gives the hidden track back to the meeting list on either side of the stacking breakpoint', () => {
  expect(css).toContain('grid-template-columns:minmax(0,1fr) var(--agenda-track)')
  expect(css).toMatch(/@container \(max-width:520px\) \{ \.native-home \{[^}]*grid-template-rows:minmax\(0,1fr\) var\(--agenda-track\)/)
  expect(css).toContain('.native-home[data-agenda-open=false] { --agenda-track:0px; }')
})

it('keeps laptop windows full width and caps the hover area in the Home, folder and Trash columns', () => {
  const maxWidth = Number(css.match(/--meeting-list-max-width:(\d+)px/)?.[1])
  const sidebar = Number(css.match(/\.workspace-sidebar,\.workspace-sidebar-gap \{ width:(\d+)px/)?.[1])
  const collapsed = Number(css.match(/\.sidebar-collapsed \.workspace-sidebar-gap \{ width:(\d+)px/)?.[1])
  const laptop = Number(css.match(/@media \(width > (\d+)px\) \{\s*:is\(\.native-home,\.native-folder\)>\.native-library>\*/)?.[1])
  expect([laptop, sidebar, collapsed, maxWidth]).toEqual([1728, 208, 0, 1520])
  expect(laptop - sidebar).toBe(maxWidth)
  expect(laptop - collapsed).toBe(1728)
  // The row's hover background extends 8px past the heading at each edge.
  expect(css).toMatch(/\.native-meeting-row \{[^}]*margin-inline:-8px/)
  expect(css).toMatch(/:is\(\.native-home,\.native-folder\)>\.native-library>\* \{[^}]*inline-size:min\(100%,calc\(var\(--meeting-list-max-width\) - 16px\)\);margin-inline:auto;/)
})
