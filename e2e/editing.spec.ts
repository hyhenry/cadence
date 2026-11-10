import { expect, test, type Page } from '@playwright/test';
import { haCommand, open, setView, touchDrag } from './helpers.ts';

const uniq = (base: string) => `${base} ${test.info().project.name} ${Date.now() % 100000}`;

async function gotoDay(page: Page, offsetDays: number) {
  await setView(page, 'Day');
  for (let i = 0; i < offsetDays; i++) await page.locator('.fc-view-harness').evaluate(() => undefined), await page.keyboard.press('ArrowRight');
}

async function createAt(page: Page, title: string, slotTime = '10:00:00') {
  const slot = page.locator(`td.fc-timegrid-slot-lane[data-time="${slotTime}"]`);
  await slot.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const box = (await slot.boundingBox())!;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  const dialog = page.getByRole('dialog', { name: 'New event' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Title').fill(title);
  return dialog;
}

test('tap an empty slot to create, then edit and delete', async ({ page }) => {
  await open(page);
  await setView(page, 'Day');
  await page.getByRole('button', { name: 'Next' }).or(page.locator('h1.title')).first().waitFor();
  const name = uniq('Vet');
  const dialog = await createAt(page, name, '10:00:00');
  await expect(dialog.getByLabel('Start time')).toHaveValue('10:00');
  await dialog.getByLabel('Location').fill('Animal clinic');
  await dialog.getByRole('button', { name: 'Save' }).click();
  const ev = page.locator('.fc-event', { hasText: name });
  await expect(ev).toBeVisible();
  await expect(ev).not.toHaveClass(/ev-pending/);

  await ev.tap();
  const edit = page.getByRole('dialog', { name: 'Edit event' });
  await expect(edit.getByLabel('Location')).toHaveValue('Animal clinic');
  await edit.getByLabel('Title').fill(`${name} (moved)`);
  await edit.getByLabel('Start time').fill('11:30');
  await expect(edit.getByLabel('End time')).toHaveValue('12:30');
  await edit.getByRole('button', { name: 'Save' }).click();
  const moved = page.locator('.fc-event', { hasText: `${name} (moved)` });
  await expect(moved).toBeVisible();
  await expect(moved).toContainText('11:30');

  await moved.tap();
  await page.getByRole('dialog', { name: 'Edit event' }).getByRole('button', { name: 'Delete event' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.fc-event', { hasText: name })).toHaveCount(0);
});

test('all-day event from the editor', async ({ page }) => {
  await open(page);
  await setView(page, 'Day');
  const name = uniq('Holiday');
  const dialog = await createAt(page, name, '08:00:00');
  await dialog.getByLabel('All day').check();
  await expect(dialog.getByLabel('Start time')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.fc-daygrid-event', { hasText: name })).toBeVisible();
});

test('recurring event: delete one occurrence, then all', async ({ page }) => {
  await open(page);
  await setView(page, 'Week');
  const name = uniq('Practice');
  const dialog = await createAt(page, name, '06:00:00');
  await dialog.getByLabel('Repeat', { exact: true }).selectOption('daily');
  await dialog.getByLabel('Repeat ends').selectOption('count');
  await dialog.getByLabel('Number of times').fill('3');
  await dialog.getByRole('button', { name: 'Save' }).click();
  const evs = page.locator('.fc-event', { hasText: name });
  await expect(evs.first()).toBeVisible();
  await setView(page, 'Agenda');
  const rows = page.locator('.fc-list-event', { hasText: name });
  await expect(rows).toHaveCount(3);
  await rows.first().tap();
  await page.getByRole('dialog', { name: 'Edit event' }).getByRole('button', { name: 'Delete event' }).click();
  await page.getByRole('dialog', { name: 'Delete recurring event' }).getByRole('button', { name: 'This event' }).click();
  await expect(rows).toHaveCount(2);
  await rows.first().tap();
  await page.getByRole('dialog', { name: 'Edit event' }).getByRole('button', { name: 'Delete event' }).click();
  await page.getByRole('dialog', { name: 'Delete recurring event' }).getByRole('button', { name: 'All events' }).click();
  await expect(rows).toHaveCount(0);
});

test('touch drag moves an event (long press, then drag)', async ({ page }) => {
  await open(page);
  await setView(page, 'Day');
  const name = uniq('Drag me');
  const dialog = await createAt(page, name, '13:00:00');
  await dialog.getByRole('button', { name: 'Save' }).click();
  const ev = page.locator('.fc-timegrid-event', { hasText: name });
  await expect(ev).toBeVisible();
  await expect(ev).not.toHaveClass(/ev-pending/);
  const box = (await ev.boundingBox())!;
  const slotH = (await page.locator('td.fc-timegrid-slot-lane[data-time="13:00:00"]').boundingBox())!.height;
  // Two hours later = four 30-minute slots.
  await touchDrag(page, { x: box.x + box.width / 2, y: box.y + 8 }, { x: box.x + box.width / 2, y: box.y + 8 + slotH * 4 - 6 }, { holdMs: 450, steps: 16 });
  await expect(page.locator('.fc-timegrid-event:not(.fc-event-mirror)', { hasText: name })).toContainText('3pm', { timeout: 8000 });
  // Persisted in HA: reload and check again.
  await page.reload();
  await setView(page, 'Day');
  await expect(page.locator('.fc-timegrid-event', { hasText: name })).toContainText('3pm');
});

test('touch resize: long-press to select, then drag the handle', async ({ page }) => {
  await open(page);
  await setView(page, 'Day');
  const name = uniq('Resize me');
  // Both projects share one mock HA, so use a different slot per project.
  const tablet = test.info().project.name === 'tablet';
  const slotTime = tablet ? '11:00:00' : '20:00:00';
  const dialog = await createAt(page, name, slotTime);
  await dialog.getByRole('button', { name: 'Save' }).click();
  const ev = page.locator('.fc-timegrid-event:not(.fc-event-mirror)', { hasText: name });
  await expect(ev).not.toHaveClass(/ev-pending/);
  const box = (await ev.boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await touchDrag(page, centre, centre, { holdMs: 450, steps: 1 });
  await expect(ev).toHaveClass(/fc-event-selected/);
  const handle = ev.locator('.fc-event-resizer-end');
  const hb = (await handle.boundingBox())!;
  const slotH = (await page.locator(`td.fc-timegrid-slot-lane[data-time="${slotTime}"]`).boundingBox())!.height;
  await touchDrag(page, { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 }, { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 + slotH * 2 - 4 }, { steps: 10 });
  await expect(page.locator('.fc-timegrid-event:not(.fc-event-mirror)', { hasText: name })).toContainText(tablet ? /11(am)? - 1pm/ : /8(pm)? - 10pm/, { timeout: 8000 });
});

test('a change Home Assistant rejects is rolled back with a message', async ({ page }) => {
  await open(page);
  await setView(page, 'Day');
  const name = uniq('Doomed');
  const dialog = await createAt(page, name, '19:00:00');
  await dialog.getByRole('button', { name: 'Save' }).click();
  const ev = page.locator('.fc-timegrid-event', { hasText: name });
  await expect(ev).not.toHaveClass(/ev-pending/);
  // Someone deletes it in HA behind Cadence's back (no live update yet arrives before we act).
  const states = await (await fetch('http://127.0.0.1:8199/api/events?start=' + encodeURIComponent(new Date(Date.now() - 864e5 * 3).toISOString()) + '&end=' + encodeURIComponent(new Date(Date.now() + 864e5 * 3).toISOString()))).json();
  const target = states.events.find((e: any) => e.summary === name);
  await page.route('**/api/stream', (r) => r.abort());
  await haCommand({ type: 'calendar/event/delete', entity_id: target.entity_id, uid: target.uid });
  await ev.tap();
  const edit = page.getByRole('dialog', { name: 'Edit event' });
  await edit.getByLabel('Title').fill(`${name} renamed`);
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /No existing event/ })).toBeVisible();
  await expect(page.locator('.fc-timegrid-event', { hasText: `${name} renamed` })).toHaveCount(0);
  void gotoDay;
});
