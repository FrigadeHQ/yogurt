import { describe, expect, it } from 'vitest'
import { watchArgs } from '../src/main/callNames/watch'

describe('watchArgs: what the call watch is asked to read', () => {
  it('names the processes on the mic when they are known, so only that meeting is read (#98)', () => {
    expect(watchArgs(['us.zoom.xos'], [501, 777])).toEqual(['call-watch', '400', '--pid', '501', '--pid', '777', 'us.zoom.xos'])
    expect(watchArgs(['us.zoom.xos'])).toEqual(['call-watch', '400', 'us.zoom.xos'])
    expect(watchArgs(['us.zoom.xos'], [])).toEqual(['call-watch', '400', 'us.zoom.xos'])
  })
  it('names the meeting number when nothing is on the mic, so the Zoom process started for it is read', () => {
    expect(watchArgs(['us.zoom.xos'], [], '95475305118')).toEqual(['call-watch', '400', '--confno', '95475305118', 'us.zoom.xos'])
  })
})
