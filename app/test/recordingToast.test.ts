import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordingDeletedToast, toasts } from '../src/renderer/src/components/TrashToast'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
function setup(keepRecordings: boolean) {
  const get = vi.fn(async () => ({ keepRecordings })), go = vi.fn(), setKeepRecordings = vi.fn()
  vi.stubGlobal('window', { yogurt: { settings: { get, setKeepRecordings }, nav: { go } } })
  const add = vi.spyOn(toasts, 'add').mockReturnValue('recording-toast')
  const close = vi.spyOn(toasts, 'close').mockImplementation(() => {})
  return { get, go, setKeepRecordings, add, close }
}
describe('recording deletion confirmation', () => {
  it('uses an eight second toast and only navigates when its Settings action is clicked', async () => {
    const s = setup(true)
    await recordingDeletedToast()
    const toast = s.add.mock.calls[0][0]
    expect(toast).toMatchObject({ title: 'Recording deleted', timeout: 8000, data: { testId: 'recording-deleted-toast', actionTestId: 'recording-settings' } })
    expect(toast.actionProps?.children).toBe('Settings')
    expect(s.go).not.toHaveBeenCalled()
    toast.actionProps?.onClick?.({} as never)
    expect(s.go).toHaveBeenCalledWith('/settings/recordings')
    expect(s.close).toHaveBeenCalledWith('recording-toast')
    expect(s.setKeepRecordings).not.toHaveBeenCalled()
  })
  it('confirms deletion without a Settings action when retention is off', async () => {
    const s = setup(false)
    await recordingDeletedToast()
    expect(s.add.mock.calls[0][0]).toMatchObject({ title: 'Recording deleted', timeout: 8000 })
    expect(s.add.mock.calls[0][0].actionProps).toBeUndefined()
    expect(s.go).not.toHaveBeenCalled()
    expect(s.setKeepRecordings).not.toHaveBeenCalled()
  })
  it('still confirms deletion if reading the current preference fails', async () => {
    const s = setup(true); s.get.mockRejectedValueOnce(new Error('unavailable'))
    await recordingDeletedToast()
    expect(s.add.mock.calls[0][0]).toMatchObject({ title: 'Recording deleted', timeout: 8000 })
    expect(s.add.mock.calls[0][0].actionProps).toBeUndefined()
  })
})
