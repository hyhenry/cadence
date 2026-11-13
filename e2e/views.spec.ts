import { expect, test } from '@playwright/test';
import { closeDrawer, haCommand, isPhone, open, openDrawer, setView, touchDrag, touchPath } from './helpers.ts';

test('loads through the ingress prefix with relative paths', async ({ page }) => {
  const bad: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.port === '8224' && !u.pathname.startsWith('/api/hassio_ingress/e2e/')) bad.push(u.pathname);
  });
  await open(page);
  expect(bad).toEqual([]);
});

test('switches between month, week, 3-day, day and agenda views', async ({ page }) => {
  await open(page);
  await setView(page, 'Month');
  await expect(page.locator('.fc-dayGridMonth-view')).toBeVisible();
  await expect(page.locator('.fc-event', { hasText: 'Grandma visiting' }).first()).toBeVisible();
  await setView(page, 'Week');
  await expect(page.locator('.fc-timeGridWeek-view')).toBeVisible();
  await setView(page, '3 days');
  await expect(page.locator('.fc-timeGrid3Day-view')).toBeVisible();
  await setView(page, 'Day');
  await expect(page.locator('.fc-timeGridDay-view')).toBeVisible();
  await setView(page, 'Agenda');
  await expect(page.locator('.fc-list')).toBeVisible();
  await expect(page.locator('.fc-list-event', { hasText: 'Dentist' })).toBeVisible();
});

test('swipe changes the period and Today comes back', async ({ page }) => {
  await open(page);
  await setView(page, 'Day');
  await expect(page.locator('.fc-timeGridDay-view')).toBeVisible();
  const title = page.locator('h1.title');
  await expect(title).toHaveText(/\d{4}/);
  const before = (await title.textContent())!;
  const box = (await page.locator('.fc-view-harness').boundingBox())!;
  await touchDrag(page, { x: box.x + box.width * 0.85, y: box.y + 200 }, { x: box.x + box.width * 0.15, y: box.y + 210 }, { steps: 6 });
  await expect(title).not.toHaveText(before);
  await expect(page.getByRole('dialog'), 'a swipe is not a tap').toHaveCount(0);
  await page.getByRole('button', { name: 'Today' }).click();
  await expect(title).toHaveText(before);
});

test('the view follows the finger, and a short swipe springs back', async ({ page }) => {
  await open(page);
  await setView(page, 'Week');
  const firstDay = page.locator('.fc-col-header-cell').first();
  const before = await firstDay.getAttribute('data-date');
  const harness = page.locator('.fc-view-harness');
  const box = (await harness.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + 220;
  // Drag 60px and check the view moved with the finger before letting go.
  const moved = page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const h = document.querySelector<HTMLElement>('.fc-view-harness')!;
        const obs = new MutationObserver(() => {
          if (h.style.transform.includes('translate3d(-')) {
            obs.disconnect();
            resolve(h.style.transform);
          }
        });
        obs.observe(h, { attributes: true, attributeFilter: ['style'] });
      }),
  );
  await touchPath(page, [{ x, y }, { x: x - 20, y, wait: 40 }, { x: x - 40, y, wait: 40 }, { x: x - 60, y, wait: 40 }, { x: x - 60, y, wait: 200 }]);
  expect(await moved).toMatch(/translate3d\(-\d+/);
  await expect(harness).toHaveAttribute('style', /^(?!.*translate3d\(-)/);
  expect(await firstDay.getAttribute('data-date')).toBe(before);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('in the 3-day view a swipe moves by the days dragged', async ({ page }) => {
  await open(page);
  await setView(page, '3 days');
  const cols = page.locator('.fc-col-header-cell');
  const before = (await cols.first().getAttribute('data-date'))!;
  const col = (await page.locator('.fc-timegrid-col.fc-day').first().boundingBox())!;
  const box = (await page.locator('.fc-view-harness').boundingBox())!;
  const y = box.y + 220;
  const x = box.x + box.width - 10;
  // About two columns, slowly (no fling), then rest before lifting.
  const pts = [{ x, y }];
  for (let i = 1; i <= 10; i++) pts.push({ x: x - (col.width * 2 * i) / 10, y, wait: 30 });
  pts.push({ x: x - col.width * 2, y, wait: 150 });
  await touchPath(page, pts);
  const expected = new Date(Date.parse(before + 'T12:00:00Z') + 2 * 86_400_000).toISOString().slice(0, 10);
  await expect(cols.first()).toHaveAttribute('data-date', expected);
});

test('calendar toggles hide and show events', async ({ page }) => {
  await open(page);
  await setView(page, 'Agenda');
  await expect(page.locator('.fc-list-event', { hasText: 'Dentist' })).toBeVisible();
  await openDrawer(page);
  await page.getByRole('switch', { name: 'Show Family' }).click();
  await closeDrawer(page);
  await expect(page.locator('.fc-list-event', { hasText: 'Dentist' })).toHaveCount(0);
  await openDrawer(page);
  await page.getByRole('switch', { name: 'Show Family' }).click();
  await closeDrawer(page);
  await expect(page.locator('.fc-list-event', { hasText: 'Dentist' })).toBeVisible();
});

test('changes made in Home Assistant appear without reloading', async ({ page }) => {
  await open(page);
  await setView(page, 'Agenda');
  const name = `From HA ${test.info().project.name}`;
  const start = new Date(Date.now() + 2 * 3600e3);
  await haCommand({ type: 'calendar/event/create', entity_id: 'calendar.work', event: { summary: name, dtstart: start.toISOString(), dtend: new Date(start.getTime() + 3600e3).toISOString() } });
  await expect(page.locator('.fc-list-event', { hasText: name })).toBeVisible({ timeout: 10_000 });
  void isPhone;
});

test('the last used view is remembered on this device', async ({ page }) => {
  await open(page);
  await setView(page, '3 days');
  await expect(page.locator('.fc-timeGrid3Day-view')).toBeVisible();
  await page.reload();
  await expect(page.locator('.fc-timeGrid3Day-view')).toBeVisible();
  await setView(page, 'Month');
  await page.reload();
  await expect(page.locator('.fc-dayGridMonth-view')).toBeVisible();
});
