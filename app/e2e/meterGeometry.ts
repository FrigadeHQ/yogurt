import type { Locator } from '@playwright/test'

/** Actual visible stroke heights, including the two non-scaling round caps. */
export const meterHeights = (meter: Locator) => meter.locator('line').evaluateAll(lines =>
  lines.map(line => Number(getComputedStyle(line).opacity) > 0
    ? line.getBoundingClientRect().height + parseFloat(getComputedStyle(line).strokeWidth) : 0))
