import { expect, type Page } from '@playwright/test'

export async function revealSidebar(page: Page) {
  const panel = page.locator('#workspace-sidebar')
  if (await panel.getAttribute('inert') !== null) await page.getByTestId('sidebar-expand').press('ArrowDown')
  await expect(panel).toBeInViewport()
}

export async function openFromCorner(page: Page, item: 'settings-open' | 'nav-trash') {
  await revealSidebar(page)
  await page.getByTestId('corner-menu-button').click()
  await page.getByTestId(item).click()
  await expect(page.getByTestId('corner-menu')).toHaveCount(0)
  await expect(page.getByTestId(item === 'nav-trash' ? 'trash-page' : 'settings')).toBeVisible()
}
