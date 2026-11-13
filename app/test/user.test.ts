import { beforeEach, expect, it, vi } from 'vitest'

const run = vi.fn(() => 'Daniel Brooks\n')
vi.mock('node:child_process', () => ({ execFileSync: run }))
const fresh = async () => { vi.resetModules(); return (await import('../src/main/user')).macFullName }
beforeEach(() => run.mockClear())

it('never runs the Mac-only id -F off a Mac (Linux printed an error): the login name instead', async () => {
  expect((await fresh())('linux')).not.toBe('')
  expect(run).not.toHaveBeenCalled()
})

it('asks the Mac for the full name', async () => {
  expect((await fresh())('darwin')).toBe('Daniel Brooks')
  expect(run).toHaveBeenCalledWith('id', ['-F'], expect.anything())
})
