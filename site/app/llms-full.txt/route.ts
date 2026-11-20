import { fullGuide } from '../../scripts/llms-full.mjs'

export const dynamic = 'force-static'

export function GET() {
  return new Response(fullGuide(), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
