import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQuietStart, QUIT_AFTER_MS } from '../src/main/quietStart'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

const make = (reason: Parameters<typeof createQuietStart>[0]['reason'], busy = () => false) => {
  const quit = vi.fn()
  const q = createQuietStart({ reason, quit, busy })
  return { q, quit }
}

describe('a Yogurt an AI app started (#147)', () => {
  it('watches for no calls and offers nothing until the person opens it', async () => {
    const { q } = make('ai-app')
    const tick = vi.fn(async () => {})
    await q.detect(tick)
    expect(q.quiet()).toBe(true)
    expect(tick).not.toHaveBeenCalled()
    q.opened()
    await q.detect(tick)
    expect(q.quiet()).toBe(false)
    expect(tick).toHaveBeenCalledOnce()
  })
  it('opens no window at start', () => {
    expect(make('ai-app').q.window()).toBe(false)
    expect(make('login').q.window()).toBe(false)
    expect(make('user').q.window()).toBe(true)
    expect(make('update').q.window()).toBe(true)
  })
  it('watches for calls right away for any other start', async () => {
    for (const reason of ['login', 'user', 'update'] as const) {
      const tick = vi.fn(async () => {})
      await make(reason).q.detect(tick)
      expect(tick).toHaveBeenCalledOnce()
    }
  })
  it('quits by itself once no AI app has been connected for a while', () => {
    const { q, quit } = make('ai-app')
    q.clients(1)
    vi.advanceTimersByTime(QUIT_AFTER_MS * 3)
    expect(quit).not.toHaveBeenCalled()
    q.clients(0)
    vi.advanceTimersByTime(QUIT_AFTER_MS - 1)
    expect(quit).not.toHaveBeenCalled()
    q.clients(1); q.clients(0)
    vi.advanceTimersByTime(QUIT_AFTER_MS - 1)
    expect(quit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(quit).toHaveBeenCalledOnce()
  })
  it('quits too when the AI app that started it never connected', () => {
    const { quit } = make('ai-app')
    vi.advanceTimersByTime(QUIT_AFTER_MS)
    expect(quit).toHaveBeenCalledOnce()
  })
  it('waits for work in progress before quitting', () => {
    let busy = true
    const { quit } = make('ai-app', () => busy)
    vi.advanceTimersByTime(QUIT_AFTER_MS * 2)
    expect(quit).not.toHaveBeenCalled()
    busy = false
    vi.advanceTimersByTime(QUIT_AFTER_MS)
    expect(quit).toHaveBeenCalledOnce()
  })
  it('stays once the person opened it, and never quits a Yogurt they started', () => {
    const opened = make('ai-app')
    opened.q.opened()
    opened.q.clients(0)
    vi.advanceTimersByTime(QUIT_AFTER_MS * 5)
    expect(opened.quit).not.toHaveBeenCalled()
    for (const reason of ['login', 'user', 'update'] as const) {
      const other = make(reason)
      other.q.clients(1); other.q.clients(0)
      vi.advanceTimersByTime(QUIT_AFTER_MS * 5)
      expect(other.quit).not.toHaveBeenCalled()
    }
  })
  it('a login start while it waits quietly makes it a normal Yogurt, still without a window', async () => {
    const { q, quit } = make('ai-app')
    q.startedAgain('login')
    expect(q.quiet()).toBe(false)
    vi.advanceTimersByTime(QUIT_AFTER_MS * 2)
    expect(quit).not.toHaveBeenCalled()
  })
  it('another AI app start changes nothing', () => {
    const { q } = make('ai-app')
    q.startedAgain('ai-app')
    expect(q.quiet()).toBe(true)
  })
})
