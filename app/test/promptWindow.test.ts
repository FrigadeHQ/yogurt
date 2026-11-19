import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ windows: [] as any[], notices: [] as any[], handlers: new Map<string, Function>(), dark: false, theme: new Set<() => void>() }))
vi.mock('electron', () => ({
  BrowserWindow: class {
    options: any; dead = false; listeners = new Map<string, Array<() => void>>()
    setBackgroundColor = vi.fn()
    constructor(options: any) { this.options = options; state.windows.push(this) }
    on(event: string, fn: () => void) { this.listeners.set(event, [...this.listeners.get(event) ?? [], fn]) }
    once(event: string, fn: () => void) { this.on(event, fn) }
    destroy() { this.dead = true; this.listeners.get('closed')?.forEach(fn=>fn()) }
    isDestroyed() { return this.dead }
    loadFile() { return Promise.resolve() }
  },
  ipcMain: { handle: (name: string, fn: Function) => state.handlers.set(name, fn) },
  Notification: class {
    static isSupported() { return true }
    close = vi.fn(); show = vi.fn(); listeners = new Map<string, () => void>()
    constructor() { state.notices.push(this) }
    on(event: string, fn: () => void) { this.listeners.set(event, fn) }
  },
  nativeTheme: {
    get shouldUseDarkColors() { return state.dark },
    on: (_name: string, fn: () => void) => state.theme.add(fn),
    removeListener: (_name: string, fn: () => void) => state.theme.delete(fn),
  },
  screen: { getPrimaryDisplay: () => ({workArea:{x:0,y:0,width:1200,height:800}}) },
}))
vi.mock('../src/main/float', async (real) => ({ ...(await real<typeof import('../src/main/float')>()), floatOverFullScreen: vi.fn() }))
let prompts: ReturnType<typeof import('../src/main/prompts').createPrompts>
beforeEach(async () => {
  vi.stubEnv('YOGURT_BACKGROUND', '0'); vi.resetModules()
  state.windows.length = 0; state.notices.length = 0; state.handlers.clear(); state.theme.clear(); state.dark = false
  const { createPrompts } = await import('../src/main/prompts')
  prompts = createPrompts({windowVisible:()=>true,takeNotes:vi.fn(),stop:vi.fn(),dismissed:vi.fn(),keepGoing:vi.fn(),dismissStop:vi.fn(),open:vi.fn()})
})
afterEach(() => { prompts.hide(); vi.unstubAllEnvs() })
it('gives both prompts the same compact frame and top-right placement', () => {
  prompts.offer({key:'call',app:'Zoom',title:'Design review'} as any)
  expect(state.windows[0].options).toMatchObject({width:381,height:60,x:803,y:12,focusable:false,backgroundColor:'#FFFFFF'})
  prompts.askStop({id:'meeting',title:'Design review'} as any)
  expect(state.windows[1].options).toMatchObject({width:381,height:60,x:803,y:12,focusable:true})
})
it("a Mac's card is a plain window, as before; Windows and Linux make it a tool window that never takes focus", async () => {
  prompts.offer({key:'call',app:'Zoom',title:''} as any)
  expect(state.windows[0].options.type).toBeUndefined()
  prompts.hide()
  const { createPrompts } = await import('../src/main/prompts')
  const pc = createPrompts({windowVisible:()=>true,takeNotes:vi.fn(),stop:vi.fn(),dismissed:vi.fn(),keepGoing:vi.fn(),dismissStop:vi.fn(),open:vi.fn(),os:'win32'})
  pc.offer({key:'call',app:'Zoom',title:''} as any)
  expect(state.windows.at(-1).options).toMatchObject({type:'toolbar',focusable:false,skipTaskbar:true})
  pc.hide()
})
it('uses the current app appearance and updates the native background without leaking listeners', () => {
  state.dark = true
  prompts.offer({key:'call',app:'Zoom',title:''} as any)
  const win = state.windows[0]
  expect(win.options.backgroundColor).toBe('#29292B')
  state.dark = false; state.theme.forEach(fn=>fn())
  expect(win.setBackgroundColor).toHaveBeenCalledWith('#FFFFFF')
  prompts.hide()
  expect(state.theme.size).toBe(0)
})


/** Real meeting lifecycle, with only the native windows and notifications replaced. */
async function recording() {
  const meeting = await import('../src/main/meeting')
  const { openStore } = await import('../src/main/store')
  const store = openStore(':memory:')
  meeting.initMeetings(store)
  const m = meeting.startMeeting({ title: 'Review fixture', event: null, app: null })
  const stop = vi.fn(meeting.stopMeeting), keepGoing = vi.fn(), dismissStop = vi.fn(), open = vi.fn()
  const { createPrompts } = await import('../src/main/prompts')
  prompts.hide()
  prompts = createPrompts({ windowVisible: () => false, takeNotes: vi.fn(), stop, dismissed: vi.fn(), keepGoing, dismissStop, open })
  prompts.askStop(m)
  return { ...meeting, store, m, stop, keepGoing, dismissStop, open, card: state.windows.at(-1), notice: state.notices.at(-1) }
}

it('stopping by hand immediately closes the stop card and its native notification', async () => {
  const r = await recording()
  try {
    r.stopMeeting(r.m.id)
    expect(r.card.isDestroyed()).toBe(true)
    expect(r.notice.close).toHaveBeenCalledOnce()
    expect(prompts.notice()).toBeNull()
    expect(state.handlers.get('prompt:state')!()).toBeNull()
    r.notice.listeners.get('click')!()
    expect(r.stop).not.toHaveBeenCalled()
  } finally { r.store.close() }
})

it('closes at capture stop even when saving the stopped state fails', async () => {
  const r = await recording()
  const save = vi.spyOn(r.store, 'updateMeeting').mockImplementation(() => { throw new Error('Disk full') })
  try {
    expect(r.stopMeeting(r.m.id)?.stopSavePending).toBe(true)
    expect(r.card.isDestroyed()).toBe(true)
    expect(r.notice.close).toHaveBeenCalledOnce()
  } finally { save.mockRestore(); r.store.close() }
})

it('stopping a different stored recording leaves the active meeting card and notification alone', async () => {
  const r = await recording()
  try {
    const other = r.store.createMeeting({ ...r.m, title: 'Other fixture' })
    r.stopMeeting(other.id)
    expect(r.activeMeeting()?.id).toBe(r.m.id)
    expect(r.card.isDestroyed()).toBe(false)
    expect(r.notice.close).not.toHaveBeenCalled()
    expect(state.handlers.get('prompt:state')!()).toMatchObject({ meetingId: r.m.id })
  } finally { r.store.close() }
})

it.each(['stop', 'keep-going', 'close', 'notification'] as const)('a stale %s action just closes without stopping or snoozing another recording', async action => {
  const r = await recording()
  try {
    r.stopMeeting(r.m.id)
    const next = r.startMeeting({ title: 'Next fixture', event: null, app: null })
    // A late/stale presentation must remain harmless even after the lifecycle event was missed.
    prompts.askStop(r.m)
    const card = state.windows.at(-1), notice = state.notices.at(-1)
    if (action === 'notification') notice.listeners.get('click')!()
    else state.handlers.get('prompt:act')!({}, action)
    expect(card.isDestroyed()).toBe(true)
    expect(notice.close).toHaveBeenCalledOnce()
    expect(prompts.notice()).toBeNull()
    expect(r.stop).not.toHaveBeenCalled()
    expect(r.keepGoing).not.toHaveBeenCalled()
    expect(r.dismissStop).not.toHaveBeenCalled()
    expect(r.activeMeeting()?.id).toBe(next.id)
    expect(r.store.meeting(r.m.id)?.state).toBe('stopped')
  } finally { r.store.close() }
})

it('Stop on an already-ended meeting closes the stale card and leaves its summary alone', async () => {
  const r = await recording()
  try {
    r.stopMeeting(r.m.id)
    r.store.setNotes(r.m.id, { mine: 'Original notes', enhanced: 'Existing summary' })
    prompts.askStop(r.m)
    const card = state.windows.at(-1), notice = state.notices.at(-1)
    state.handlers.get('prompt:act')!({}, 'stop')
    expect(card.isDestroyed()).toBe(true)
    expect(notice.close).toHaveBeenCalledOnce()
    expect(r.stop).not.toHaveBeenCalled()
    expect(r.keepGoing).not.toHaveBeenCalled()
    expect(r.dismissStop).not.toHaveBeenCalled()
    expect(r.activeMeeting()).toBeNull()
    expect(r.store.notes(r.m.id)).toMatchObject({ mine: 'Original notes', enhanced: 'Existing summary' })
  } finally { r.store.close() }
})

it.each(['stop', 'keep-going'] as const)('the live %s action still works and closes both surfaces', async action => {
  const r = await recording()
  try {
    state.handlers.get('prompt:act')!({}, action)
    expect(r.card.isDestroyed()).toBe(true)
    expect(r.notice.close).toHaveBeenCalledOnce()
    if (action === 'stop') expect(r.stop).toHaveBeenCalledWith(r.m.id)
    else { expect(r.keepGoing).toHaveBeenCalledOnce(); expect(r.activeMeeting()?.id).toBe(r.m.id) }
  } finally { r.store.close() }
})

it('preserves the informational call-ended notice after closing the obsolete stop question', async () => {
  const r = await recording()
  try {
    r.stopMeeting(r.m.id)
    prompts.stopped(r.m)
    expect(r.card.isDestroyed()).toBe(true)
    expect(r.notice.close).toHaveBeenCalledOnce()
    expect(prompts.notice()?.title).toBe('Recording stopped when the call ended.')
    prompts.clickNotice()
    expect(r.open).toHaveBeenCalledWith(r.m.id)
    expect(r.stop).not.toHaveBeenCalled()
  } finally { r.store.close() }
})

it('Close hides the card and system notification without stopping or snoozing the recording', async () => {
  const r = await recording()
  try {
    state.handlers.get('prompt:act')!({}, 'close')
    expect(r.card.isDestroyed()).toBe(true)
    expect(r.notice.close).toHaveBeenCalledOnce()
    expect(prompts.notice()).toBeNull()
    expect(r.dismissStop).toHaveBeenCalledOnce()
    expect(r.stop).not.toHaveBeenCalled()
    expect(r.keepGoing).not.toHaveBeenCalled()
    expect(r.activeMeeting()?.id).toBe(r.m.id)
  } finally { r.store.close() }
})
