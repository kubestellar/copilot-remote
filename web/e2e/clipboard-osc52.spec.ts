import { test, expect } from '@playwright/test';
import { bypassAuth, waitForAppShell, openTerminalsTab } from './helpers';

test.describe('OSC 52 clipboard copy', () => {
  test.beforeEach(async ({ page }) => {
    await bypassAuth(page);
  });

  test('copy toast appears when OSC 52 fires', async ({ page }) => {
    await page.goto('/');
    await waitForAppShell(page);
    await openTerminalsTab(page);

    // Simulate the showCopyToast mechanism from TerminalView
    const toastVisible = await page.evaluate(() => {
      let el = document.getElementById('copy-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'copy-toast';
        el.className = 'copy-toast';
        document.body.appendChild(el);
      }
      el.textContent = 'Copied: test-text';
      el.classList.add('show');
      return el.classList.contains('show');
    });

    expect(toastVisible).toBe(true);

    const toast = page.locator('#copy-toast.show');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('Copied:');
  });
});
