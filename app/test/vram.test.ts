import { describe, expect, it } from 'vitest'
import { vramCap, WHISPER_VRAM } from '../src/engine/vram'

const GiB = 1024 ** 3

describe('how much graphics memory the notes model plans for (#165)', () => {
  it('an RTX A2000 Laptop (4 GB) next to an Iris Xe: only the card\'s own memory, less room for whisper-server', () => {
    // node-llama-cpp's 21.2 GB: the Iris Xe's 17.2 GB of shared memory plus the card's 4 GB
    const cap = vramCap({ total: 21.2 * GiB, unifiedSize: 17.2 * GiB }, 'win32')!
    expect(cap).toBeLessThan(4 * GiB - WHISPER_VRAM)
    expect(cap).toBeGreaterThan(2 * GiB)
  })
  it('a card alone: all of it, less room for whisper-server', () => {
    expect(vramCap({ total: 12 * GiB, unifiedSize: 0 }, 'linux')).toBe(12 * GiB - WHISPER_VRAM)
  })
  it('graphics built into the processor only, no graphics, or a Mac: node-llama-cpp\'s own count, as before', () => {
    expect(vramCap({ total: 16 * GiB, unifiedSize: 16 * GiB }, 'win32')).toBeNull()
    expect(vramCap({ total: 0, unifiedSize: 0 }, 'linux')).toBeNull()
    expect(vramCap({ total: 64 * GiB, unifiedSize: 64 * GiB }, 'darwin')).toBeNull()
  })
})
