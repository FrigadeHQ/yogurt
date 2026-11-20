import type { MetadataRoute } from 'next'
import releases from '../content/updates.json'
import { pageUrls } from '../scripts/site-urls.mjs'

export default function sitemap(): MetadataRoute.Sitemap {
  return pageUrls.map(url => ({ url, lastModified: releases[0].published }))
}
