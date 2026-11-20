import releases from '../../content/updates.json'
import { updatesPage } from '../../scripts/updates.mjs'
import { siteResponse } from '../site-response'

export const dynamic = 'force-static'

export function GET() {
  return siteResponse(updatesPage(releases))
}
