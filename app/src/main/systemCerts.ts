import * as nodeTls from 'node:tls'

type Tls = Pick<typeof nodeTls, 'getCACertificates' | 'setDefaultCACertificates'>

/**
 * Trust the certificates Windows, macOS or Linux trust, on top of Node's own list. A company that inspects HTTPS
 * re-signs every site with a certificate its IT installs in the system; Node knew nothing of it, so downloading the
 * models failed there (#115). Returns how many system certificates were added; a failure here never stops start-up.
 */
export function trustSystemCertificates(tls: Tls = nodeTls): number {
  try {
    const bundled = tls.getCACertificates('default')
    const known = new Set(bundled)
    const added = tls.getCACertificates('system').filter((c) => !known.has(c))
    if (added.length) tls.setDefaultCACertificates([...bundled, ...added])
    return added.length
  } catch {
    return 0
  }
}
