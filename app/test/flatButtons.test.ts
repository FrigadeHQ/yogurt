import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const styles = ['styles', 'workspace', 'setup'].map(name =>
  readFileSync(new URL(`../src/renderer/src/${name}.css`, import.meta.url), 'utf8'),
).join('\n')

it('keeps a flat face on bordered controls, including selected, paused and processing states', () => {
  const controls = [
    '.workspace-button', '.note-recording-group', '.note-record-action',
    '.note-resume-action', '.citation-tabs button', '.modal-button', '.ob-button',
    '.settings-select', '.settings-toggle',
    // the recording pill's mark and wave: no glow in either theme
    '.widget-details',
  ]
  const rules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  for (const control of controls) {
    const matches = rules.filter(([, selector]) => selector.includes(control) && !selector.includes('.primary') && !selector.includes('.settings-toggle[aria-checked=true]'))
    expect(matches.length, control).toBeGreaterThan(0)
    for (const [, selector, declarations] of matches) {
      expect(declarations, selector).not.toMatch(/box-shadow\s*:(?!\s*none\b)|gradient\(|drop-shadow\(/)
    }
  }
})

it('uses one saturated fill and white ink for controls while standalone accents follow the theme', () => {
  const values = (token: string) => [...styles.matchAll(new RegExp('(?:^|[;{\\s])' + token + ':\\s*([^;]+);', 'g'))].map(match => match[1])
  expect(values('--primary')).toEqual(['#6F00FF'])
  expect(values('--primary-ink')).toEqual(['#FFFFFF'])
  expect(values('--accent')).toEqual(['#6F00FF', '#B780FF'])
  // The recording pill is dark in both themes, so its accent never follows the light theme's deep purple.
  expect(values('--pill-accent')).toEqual(['#B780FF'])
})

it('retains the recording primary gradient, pressed depth and divider', () => {
  expect(styles).toMatch(/\.workspace-button\.primary \{[^}]*background-image:linear-gradient\(180deg,#FFFFFF14,transparent 55%,#0000000A\);border-color:#00000014;/)
  expect(styles).toMatch(/\.workspace-button\.primary:active:not\(:disabled\) \{[^}]*box-shadow:inset 0 1px 2px #00000033;/)
  expect(styles).toMatch(/\.primary\.recording-chevron \{[^}]*border-inline-start:1px solid #FFFFFF26;/)
})

it('sizes the note header and its loading placeholders from the standard button height', () => {
  expect(styles).toContain('--button-height: 30px')
  for (const selector of ['.ghost-btn,.workspace-button', '.note-chip, .note-record-action', '.note-recording-group[data-recording=true]', '.note-finishing', '.loading-note-chip']) {
    const rule = styles.split(`\n${selector} {`)[1]?.split('}')[0]
    expect(rule, selector).toContain('height:var(--button-height)')
  }
  expect(styles).toMatch(/\.note-folder-name \{[^}]*height:100%/)
  expect(styles).toMatch(/\.note-recording-group\[data-recording=true\] \.note-record-action \{[^}]*height:100%/)
})
