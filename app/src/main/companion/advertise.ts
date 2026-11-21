// Bonjour for the companion: the phone finds this computer as _yogurt._tcp on the local network.
import { Bonjour, type Service } from 'bonjour-service'

export type Advert = { name: string; port: number; txt: Record<string, string> }
export type Advertiser = {
  publish: (a: Advert) => void; stop: () => void; /** says goodbye on the network, then lets go */ destroy?: () => Promise<void>
  /** set by the companion: the network refused the advert (macOS Local Network permission, a firewall), so no phone can find it */
  onFailure?: () => void
}

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
  const adv: Advertiser = {
    publish(a) {
      // the same advert again: nothing to do (re-announcing churns the network)
      const key = JSON.stringify(a)
      if (key === current) return
      stop()
      try {
        bonjour ??= new Bonjour(undefined, (err: Error) => { log('COMPANION', 'mdns error', err?.name); adv.onFailure?.() })
        service = bonjour.publish({ name: a.name, type: 'yogurt', protocol: 'tcp', port: a.port, txt: a.txt })
        service.on('error', (err: Error) => { log('COMPANION', 'advert error', err?.name); adv.onFailure?.() })
        current = key
        log('COMPANION', 'advertising', `pairing=${a.txt.pairing}`)
      } catch (err) { log('COMPANION', 'advert failed', (err as Error).name); adv.onFailure?.() }
    },
    stop,
    async destroy() {
      const b = bonjour
      bonjour = null
      if (!b) return
      service = null
      current = ''
      // unpublishAll sends the goodbye packets; destroy closes the socket only after
      await new Promise<void>((r) => { try { b.unpublishAll(() => r()) } catch { r() } })
      await new Promise<void>((r) => { try { b.destroy(() => r()) } catch { r() } })
    },
  }
  return adv
}
