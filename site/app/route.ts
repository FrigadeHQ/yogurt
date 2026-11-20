import { homePage } from '../scripts/site-page.mjs'
import { siteResponse } from './site-response'

export const dynamic = 'force-static'

export function GET() {
  return siteResponse(homePage())
}
