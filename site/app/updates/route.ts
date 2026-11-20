import releases from '../../scripts/release-history.mjs'
import { updatesPage } from '../../scripts/updates.mjs'
import { siteResponse } from '../site-response'

export const dynamic = 'force-static'

export function GET() {
  return siteResponse(updatesPage(releases))
}
