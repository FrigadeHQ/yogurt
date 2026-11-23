import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const builder = readFileSync(join(__dirname, '../electron-builder.yml'), 'utf8')
const nsh = readFileSync(join(__dirname, '../build/installer.nsh'), 'utf8')

// a small C: drive: the installer asks where Yogurt goes and where its AI models go; nothing about it in the app
describe('Windows installer', () => {
  it('lets the person pick the install folder, still per user with no admin prompt', () => {
    expect(builder).toMatch(/oneClick: false/)
    expect(builder).toMatch(/allowToChangeInstallationDirectory: true/)
    expect(builder).toMatch(/perMachine: false/)
    expect(builder).toMatch(/include: build\/installer\.nsh/)
  })
  it('never offers "Anyone who uses this computer" (that one needs an admin): always just this person', () => {
    const body = nsh.match(/!macro customInstallMode\b([\s\S]*?)!macroend/)?.[1] ?? ''
    expect(body).toMatch(/StrCpy \$isForceCurrentInstall "1"/)
  })
  it('asks where the models go after the install folder, never on an update or when models already exist, and saves it where the app reads it', () => {
    expect(nsh).toContain('!macro customPageAfterChangeDir')
    expect(nsh).toContain('${If} ${Silent}')
    expect(nsh).toContain('$APPDATA\\Yogurt\\models\\*.*')
    expect(nsh).toContain('$APPDATA\\Yogurt\\models-dir.txt')
    expect(nsh).toContain('FileWriteUTF16LE')
  })
  it('the models page has its own heading, not the install folder page\'s', () => {
    const create = nsh.match(/Function modelsPageCreate([\s\S]*?)FunctionEnd/)?.[1] ?? ''
    expect(create).toMatch(/GetDlgItem \$\d \$HWNDPARENT 1037[\s\S]*WM_SETTEXT[\s\S]*AI models/)
    expect(create).toMatch(/GetDlgItem \$\d \$HWNDPARENT 1038[\s\S]*WM_SETTEXT/)
  })
})
