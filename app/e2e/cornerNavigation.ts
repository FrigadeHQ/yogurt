import { expect, type Page } from '@playwright/test'

export async function openFromCorner(page: Page, item: 'settings-open' | 'nav-trash') {
  await page.getByTestId('corner-menu-button').click()
  await page.getByTestId(item).click()
  await expect(page.getByTestId('corner-menu')).toHaveCount(0)
  await expect(page.getByTestId(item === 'nav-trash' ? 'trash-page' : 'settings')).toBeVisible()
}
