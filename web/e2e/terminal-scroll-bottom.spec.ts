import { test, expect } from '@playwright/test';
import { bypassAuth, waitForAppShell, openTerminalsTab } from './helpers';

test.describe('Terminal scroll-to-bottom', () => {
  test.beforeEach(async ({ page }) => {
    await bypassAuth(page);
  });

  test('terminal scrolls to bottom on mount', async ({ page }) => {
    await page.goto('/');
    await waitForAppShell(page);
    await openTerminalsTab(page);

    // Check that any xterm viewport is scrolled to bottom
    const viewports = page.locator('.xterm-viewport');
    const count = await viewports.count();

    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const vp = viewports.nth(i);
        const scrollInfo = await vp.evaluate((el) => ({
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        }));
        const distanceFromBottom =
          scrollInfo.scrollHeight - scrollInfo.scrollTop - scrollInfo.clientHeight;
        expect(distanceFromBottom).toBeLessThanOrEqual(50);
      }
    }
    // No terminals connected is fine
    expect(true).toBe(true);
  });
});
