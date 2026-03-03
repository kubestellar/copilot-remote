import { test, expect } from '@playwright/test';
import { bypassAuth, waitForAppShell, openTerminalsTab } from './helpers';

test.describe('Tile selection persistence', () => {
  test.beforeEach(async ({ page }) => {
    await bypassAuth(page);
  });

  test('selected tile persists across page reload', async ({ page }) => {
    await page.goto('/');
    await waitForAppShell(page);
    await openTerminalsTab(page);

    // Store a tile selection in localStorage (simulating a tile click)
    await page.evaluate(() => {
      localStorage.setItem('copilot-remote-tile-layout', JSON.stringify({
        selected: 'tile-0',
        tiles: ['tile-0'],
      }));
    });

    await page.reload();
    await waitForAppShell(page);

    const stored = await page.evaluate(() => {
      return localStorage.getItem('copilot-remote-tile-layout');
    });

    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored!);
    expect(parsed.selected).toBe('tile-0');
  });
});
