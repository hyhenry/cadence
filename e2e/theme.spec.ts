import { expect, test } from '@playwright/test';
import { MOCK_URL, open } from './helpers.ts';

test('inside Home Assistant the app follows HA light/dark mode, live', async ({ page }) => {
  // The device says dark, HA says light: HA wins.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${MOCK_URL}/mock/ha-frame?theme=light&token=e2e`);
  const app = page.frameLocator('iframe[title="Calendar"]');
  const html = app.locator('html');
  await expect(app.getByTestId('calendar')).toBeVisible();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect.poll(() => html.evaluate((el) => getComputedStyle(document.body).backgroundColor)).toBe('rgb(250, 250, 250)');

  // Switch HA to dark: the app follows straight away (well within the 5 s safety net).
  await page.evaluate(() => (window as any).setTheme('dark'));
  await expect(html).toHaveAttribute('data-theme', 'dark', { timeout: 1500 });
  await expect.poll(() => html.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(17, 17, 17)');
  // HA's own colours are used, e.g. its card colour for the top bar.
  await expect.poll(() => app.locator('.topbar').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(28, 28, 28)');

  // And back to light, with HA's dark-only values cleared.
  await page.evaluate(() => (window as any).setTheme('light'));
  await expect(html).toHaveAttribute('data-theme', 'light', { timeout: 1500 });
  await expect.poll(() => app.locator('.topbar').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');
});

test('outside Home Assistant it follows the device setting', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await open(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('inside Home Assistant the top bar is not pushed down or clipped', async ({ page }) => {
  await page.goto(`${MOCK_URL}/mock/ha-frame?theme=light&token=e2e`);
  const app = page.frameLocator('iframe[title="Calendar"]');
  await expect(app.getByTestId('calendar')).toBeVisible();
  await expect(app.locator('html')).toHaveClass(/embedded/);
  const bar = await app.locator('.topbar').boundingBox();
  const title = await app.locator('h1.title').boundingBox();
  expect(bar!.y).toBe(0);
  expect(bar!.height).toBeLessThanOrEqual(60);
  expect(title!.y + title!.height).toBeLessThanOrEqual(bar!.y + bar!.height);
});
