// Bonjour for the companion: the phone finds this computer as _yogurt._tcp on the local network.
import { Bonjour, type Service } from 'bonjour-service'

export type Advert = { name: string; port: number; txt: Record<string, string> }
export type Advertiser = { publish: (a: Advert) => void; stop: () => void; destroy?: () => void }

/** mDNS through bonjour-service (plain JavaScript, so the same on Mac, Windows and Linux) */
export function bonjourAdvertiser(log: (...parts: unknown[]) => void): Advertiser {
  let bonjour: Bonjour | null = null
  let service: Service | null = null
  let current = ''
  const stop = () => {
    const s = service
    service = null
    current = ''
    try { s?.stop?.() } catch (err) { log('COMPANION', 'advert stop failed', (err as Error).name) }
  }
  return {
    publish(a) {
      // the same advert again: nothing to do (re-announcing churns the network)
      const key = JSON.stringify(a)
      if (key === current) return
      stop()
      try {
        bonjour ??= new Bonjour(undefined, (err: Error) => log('COMPANION', 'mdns error', err?.name))
        service = bonjour.publish({ name: a.name, type: 'yogurt', protocol: 'tcp', port: a.port, txt: a.txt })
        service.on('error', (err: Error) => log('COMPANION', 'advert error', err?.name))
        current = key
        log('COMPANION', 'advertising', `pairing=${a.txt.pairing}`)
      } catch (err) { log('COMPANION', 'advert failed', (err as Error).name) }
    },
    stop,
    destroy() {
      stop()
      try { bonjour?.destroy() } catch { /* already gone */ }
      bonjour = null
    },
  }
}
