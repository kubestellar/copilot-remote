import { test, expect } from '@playwright/test';
import { bypassAuth, waitForAppShell } from './helpers';

test.describe('Active terminal persistence', () => {
  test.beforeEach(async ({ page }) => {
    await bypassAuth(page);
  });

  test('active tab persists across page reload', async ({ page }) => {
    await page.goto('/');
    await waitForAppShell(page);

    // Click on Terminals tab
    await page.click('text=Terminals');
    await page.waitForTimeout(300);

    const savedTab = await page.evaluate(() => {
      return localStorage.getItem('copilot-remote-active-tab');
    });
    expect(savedTab).toBe('terminal');

    await page.reload();
    await waitForAppShell(page);

    const tabAfterReload = await page.evaluate(() => {
      return localStorage.getItem('copilot-remote-active-tab');
    });
    expect(tabAfterReload).toBe('terminal');
  });

  test('active session persists across page reload', async ({ page }) => {
    await page.goto('/');
    await waitForAppShell(page);

    await page.evaluate(() => {
      localStorage.setItem('copilot-remote-active-session', 'test-session-123');
    });

    await page.reload();
    await waitForAppShell(page);

    const sessionAfterReload = await page.evaluate(() => {
      return localStorage.getItem('copilot-remote-active-session');
    });
    expect(sessionAfterReload).toBe('test-session-123');
  });
});
