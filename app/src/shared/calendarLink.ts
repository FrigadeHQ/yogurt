/** https (webcal is the same address), or plain http only on this computer (tests) */
export function calendarAddress(raw: string): URL | null {
  let url: URL
  try { url = new URL(raw.trim().replace(/^webcals?:\/\//i, 'https://')) } catch { return null }
  if (url.protocol === 'https:') return url
  if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return url
  return null
}
