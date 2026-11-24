import { describe, expect, it } from 'vitest'
import { createLabelWait } from '../src/main/labelsWait'

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('labelWait', () => {
  it('resolves at once when the meeting needs nothing', async () => {
    const w = createLabelWait({ wanted: () => true, pending: () => false })
    await w.wait('m1')
  })
  it('holds while voices are unlabeled, and a second wait joins the first', async () => {
    let pending = true
    const w = createLabelWait({ wanted: () => true, pending: () => pending })
    let done = false, joined = false
    void w.wait('m1').then(() => { done = true })
    void w.wait('m1').then(() => { joined = true })
    await tick()
    expect(done).toBe(false)
    expect(joined).toBe(false)
    pending = false
    w.recheck('m1')
    await tick()
    expect(done).toBe(true)
    expect(joined).toBe(true)
  })
  it('the release lets it write even though nothing was labeled', async () => {
    const w = createLabelWait({ wanted: () => true, pending: () => true })
    let done = false
    void w.wait('m1').then(() => { done = true })
    await tick()
    expect(done).toBe(false)
    w.forget('m1')
    await tick()
    expect(done).toBe(true)
  })
  it('the switch off never holds anything, and a held meeting goes on when it is switched off', async () => {
    let wanted = false
    const w = createLabelWait({ wanted: () => wanted, pending: () => true })
    await w.wait('m1')
    wanted = true
    let done = false
    void w.wait('m1').then(() => { done = true })
    await tick()
    expect(done).toBe(false)
    wanted = false
    w.recheck('m1')
    await tick()
    expect(done).toBe(true)
  })
  it('a held wait for one meeting says nothing about another', async () => {
    const w = createLabelWait({ wanted: () => true, pending: (id) => id === 'm1' })
    const held = w.wait('m1')
    await w.wait('m2')
    let m2 = false
    void w.wait('m2').then(() => { m2 = true })
    await tick()
    expect(m2).toBe(true)
    w.forget('m1')
    await held
  })
})
