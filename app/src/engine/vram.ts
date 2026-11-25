const GiB = 1024 ** 3
/** whisper-server on the same card: large-v3-turbo's 0.57 GB, beam 5's buffers and Vulkan's own, with a little to spare */
export const WHISPER_VRAM = 1.25 * GiB
/** node-llama-cpp's own safety margin (its defaultLlamaVramPadding), for the card's memory alone */
const margin = (bytes: number) => Math.floor(Math.min(bytes * 0.08, 1.6 * GiB))

/**
 * Windows and Linux: how much graphics memory the notes model may plan for, or null for node-llama-cpp's own count (#165).
 * With a card next to graphics built into the processor, llama.cpp runs on the card alone, but node-llama-cpp adds the
 * shared memory the built-in graphics could use to the card's own: 21.2 GB for a 4 GB RTX A2000 next to an Iris Xe, so
 * every layer and a 32k context went on the card. whisper-server sits on the same card too.
 */
export function vramCap(s: { total: number; unifiedSize: number }, platform: string): number | null {
  if (platform === 'darwin') return null
  const own = s.total - s.unifiedSize
  // no card, or a small one: as before (the same 2 GB as main/hardware.ts)
  if (own < 2e9) return null
  // with built-in graphics, node-llama-cpp's margin came off the whole 21 GB: it goes on the card's own here
  return Math.max(0, Math.floor(own - (s.unifiedSize > 0 ? margin(own) : 0) - WHISPER_VRAM))
}
