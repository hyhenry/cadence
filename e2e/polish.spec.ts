import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { open, openDrawer, setView } from './helpers.ts';

async function axe(page: Page, label: string) {
  // Event chips use the user's own calendar colour with white text (black on light colours);
  // that is a deliberate choice, so they are left out of the contrast check.
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).exclude('.fc-event').analyze();
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const summary = serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0]?.target.join(' ')}`);
  expect(summary, `${label} accessibility`).toEqual([]);
}

test('keyboard shortcuts', async ({ page }) => {
  await open(page);
  await page.locator('body').click({ position: { x: 5, y: 300 } }).catch(() => undefined);
  await page.keyboard.press('Escape');
  await page.keyboard.press('m');
  await expect(page.locator('.fc-dayGridMonth-view')).toBeVisible();
  const title = page.locator('h1.title');
  const month = await title.textContent();
  await page.keyboard.press('ArrowRight');
  await expect(title).not.toHaveText(month!);
  await page.keyboard.press('t');
  await expect(title).toHaveText(month!);
  await page.keyboard.press('a');
  await expect(page.locator('.fc-list')).toBeVisible();
  await page.keyboard.press('n');
  const editor = page.getByRole('dialog', { name: 'New event' });
  await expect(editor).toBeVisible();
  // Typing in the editor must not trigger shortcuts.
  await editor.getByLabel('Title').fill('m');
  await expect(page.locator('.fc-list')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
});

test('hidden calendars and lost connection have clear states', async ({ page }) => {
  await open(page);
  await openDrawer(page);
  const switches = page.getByRole('switch');
  const n = await switches.count();
  for (let i = 0; i < n; i++) if ((await switches.nth(i).getAttribute('aria-checked')) === 'true') await switches.nth(i).click();
  await expect(page.getByText('All calendars are hidden.')).toBeVisible();
  for (let i = 0; i < n; i++) await switches.nth(i).click();
  await expect(page.getByText('All calendars are hidden.')).toHaveCount(0);

  await page.route('**/api/stream', (r) => r.abort());
  await page.evaluate(() => window.dispatchEvent(new Event('cadence-test')));
  await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: 'Lost connection to the calendar' })).toBeVisible({ timeout: 10_000 });
});

test('no serious accessibility problems in the main screens', async ({ page }) => {
  // Reduced motion: no fade-in animations, so contrast is measured on the final colours.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  await axe(page, 'calendar');
  await setView(page, 'Agenda');
  await axe(page, 'agenda');
  await openDrawer(page);
  await axe(page, 'drawer');
  await page.getByRole('button', { name: 'Settings & reminders' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await axe(page, 'settings');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'New event' }).click();
  await expect(page.getByRole('dialog', { name: 'New event' })).toBeVisible();
  await axe(page, 'editor');
});

test('dark theme also passes the accessibility checks', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await open(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await axe(page, 'calendar (dark)');
  await page.getByRole('button', { name: 'New event' }).click();
  await axe(page, 'editor (dark)');
});
