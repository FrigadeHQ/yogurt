import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// Windows checks the file out with CRLF line endings
const config = readFileSync(join(__dirname, '../electron-builder.yml'), 'utf8').replaceAll('\r\n', '\n')

it('uninstalling on Windows never deletes the profile: it holds every meeting', () => {
  expect(config).toMatch(/^nsis:\n(?:  .*\n)*  deleteAppDataOnUninstall: false$/m)
  expect(config).not.toMatch(/deleteAppDataOnUninstall: true/)
})

it('Windows and Linux builds have fixed file names, like the Mac one', () => {
  expect(config).toContain('artifactName: Yogurt-mac-${arch}.${ext}')
  expect(config).toContain('artifactName: Yogurt-windows-${arch}.${ext}')
  expect(config).toContain('artifactName: Yogurt-linux-${arch}.${ext}')
})

it('ships the compact and titled Mac tray templates at both display scales', () => {
  for (const scale of [1, 2]) {
    // tray-labels: the same logo with the red exclamation, the same size as the tray icon so the menu bar icon
    // does not change size when a summary starts waiting for labels
    for (const [name, width, height] of [['tray', 22, 22], ['tray-titled', 23, 22], ['tray-labels', 22, 22]] as const) {
      const file = name + (scale === 2 ? '@2x' : '') + '.png'
      expect(config).toContain('"' + file + '"')
      const png = readFileSync(join(__dirname, '../resources', file))
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([width * scale, height * scale])
    }
  }
})

it("only Windows and Linux carry the colour tray icons (the Mac's package keeps its own files)", () => {
  const block = (name: string) => config.match(new RegExp(`^${name}:\\n((?:  .*\\n|\\n)*)`, 'm'))?.[1] ?? ''
  for (const os of ['win', 'linux']) expect(block(os)).toContain('filter: ["tray-color*.png", "tray-recording*.png", "tray-labels*.png"]')
  expect(config.split(/^win:$/m)[0]).not.toContain('tray-color')
  // the colour tray icons are 16 px (the Windows tray's size); the attention one matches the menu bar's logo
  for (const [state, size] of [['color', 16], ['recording', 16], ['labels', 22]] as const) for (const theme of ['', '-dark']) for (const [scale, px] of [['', size], ['@2x', size * 2]] as const) {
    const png = readFileSync(join(__dirname, '../resources', `tray-${state}${theme}${scale}.png`))
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([px, px])
  }
})

it("only Windows and Linux carry the speed check's clip: a Mac never times its speech model", () => {
  const block = (name: string) => config.match(new RegExp(`^${name}:\\n((?:  .*\\n|\\n)*)`, 'm'))?.[1] ?? ''
  for (const os of ['win', 'linux']) expect(block(os)).toContain('{ from: resources/speed, to: speed }')
  expect(config.split(/^win:$/m)[0]).not.toContain('resources/speed')
})

it('nemo-speech carries its model index where its CLI looks for it, on every platform', () => {
  // the CLI resolves a --model against <bin>/../share/nemo-speech/model-index.json (model_store.cpp at the pin) and
  // throws without it, so diarization would fail before it reads anything: the pack must put share beside bin
  expect(config.split(/^win:$/m)[0]).toContain('- from: resources/share\n    to: share')
})

it('the Linux build starts through the launcher that picks X11 on Wayland (#8)', () => {
  expect(config).toMatch(/^afterPack: scripts\/linux-launcher\.cjs$/m)
})
