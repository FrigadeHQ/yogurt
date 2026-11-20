import type { MetadataRoute } from 'next'
import releases from '../scripts/release-history.mjs'
import { pageUrls } from '../scripts/site-urls.mjs'

export default function sitemap(): MetadataRoute.Sitemap {
  return pageUrls.map(url => ({ url, lastModified: releases[0].published }))
}
