import { type Page } from '@playwright/test';

/** Bypass the auth-token setup screen by injecting a localStorage token */
export async function bypassAuth(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('copilot-remote-token', 'test-token');
  });
}

/** Wait for the app shell to be visible (main heading or nav) */
export async function waitForAppShell(page: Page) {
  await page.waitForSelector('text=Copilot Remote', { timeout: 15_000 });
}

/** Navigate to the Terminals tab */
export async function openTerminalsTab(page: Page) {
  const tab = page.locator('text=Terminals');
  if (await tab.count()) {
    await tab.click();
    await page.waitForTimeout(500);
  }
}
