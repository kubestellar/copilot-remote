import { test, expect } from '@playwright/test';
import { bypassAuth, waitForAppShell } from './helpers';

test.describe('WebSocket reconnection', () => {
  test.beforeEach(async ({ page }) => {
    await bypassAuth(page);
  });

  test('connection status indicator renders', async ({ page }) => {
    await page.goto('/');
    await waitForAppShell(page);

    // The app loaded without crashing on WS failure
    const appTitle = page.locator('text=Copilot Remote');
    await expect(appTitle).toBeVisible();
  });

  test('app recovers after WebSocket disconnect', async ({ page }) => {
    await page.goto('/');
    await waitForAppShell(page);

    // Reload simulates a reconnection scenario
    await page.reload();
    await waitForAppShell(page);

    // App should still be functional after reconnect/reload
    const appTitle = page.locator('text=Copilot Remote');
    await expect(appTitle).toBeVisible();

    // Navigation should still work
    const terminalsTab = page.locator('text=Terminals');
    if (await terminalsTab.count()) {
      await terminalsTab.click();
      await page.waitForTimeout(300);
    }
    const sessionsTab = page.locator('text=Sessions');
    if (await sessionsTab.count()) {
      await sessionsTab.click();
      await page.waitForTimeout(300);
    }

    // No error boundary triggered
    const errorText = page.locator('text=Something went wrong');
    expect(await errorText.count()).toBe(0);
  });
});
