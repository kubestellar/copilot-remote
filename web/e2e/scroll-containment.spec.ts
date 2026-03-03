import { test, expect } from '@playwright/test';
import { bypassAuth, waitForAppShell, openTerminalsTab } from './helpers';

test.describe('Scroll containment', () => {
  test.beforeEach(async ({ page }) => {
    await bypassAuth(page);
  });

  test('scroll events stay within terminal viewport', async ({ page }) => {
    await page.goto('/');
    await waitForAppShell(page);
    await openTerminalsTab(page);

    // Verify that the xterm viewport CSS prevents page scroll leak
    const hasScrollContainment = await page.evaluate(() => {
      const style = document.querySelector('[data-tile-xterm]');
      if (!style) return false;
      const text = style.textContent || '';
      return text.includes('overflow-y: scroll') || text.includes('overflow-y:scroll');
    });

    expect(hasScrollContainment).toBe(true);

    // Verify the page itself doesn't scroll when at top
    const scrollBefore = await page.evaluate(() => window.scrollY);
    expect(scrollBefore).toBe(0);

    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(200);

    const scrollAfter = await page.evaluate(() => window.scrollY);
    expect(scrollAfter).toBeLessThanOrEqual(5);
  });
});
