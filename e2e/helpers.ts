import { expect, type Page } from '@playwright/test';

export const MOCK_URL = 'http://127.0.0.1:8224';

export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1000) < 600;

export async function open(page: Page) {
  await page.goto('./');
  await expect(page.getByTestId('calendar')).toBeVisible();
  await expect(page.locator('.fc-event').first()).toBeVisible();
}

export async function setView(page: Page, label: 'Month' | 'Week' | '3 days' | 'Day' | 'Agenda') {
  const values = { Month: 'dayGridMonth', Week: 'timeGridWeek', '3 days': 'timeGrid3Day', Day: 'timeGridDay', Agenda: 'listAgenda' } as const;
  if ((page.viewportSize()?.width ?? 1000) < 900) await page.getByRole('combobox', { name: 'View' }).selectOption(values[label]);
  else await page.getByRole('tab', { name: label, exact: true }).click();
}

export async function openDrawer(page: Page) {
  if (isPhone(page)) await page.getByRole('button', { name: 'Calendars and settings' }).click();
  await expect(page.getByRole('navigation', { name: 'Calendars' })).toBeVisible();
}

export async function closeDrawer(page: Page) {
  if (isPhone(page)) await page.getByRole('button', { name: 'Close menu' }).click();
}

/**
 * Touch drag with real TouchEvent objects dispatched in the page (start on the
 * element under the finger, moves and end on that same target, as browsers do).
 * Chromium's CDP touch emulation turns moves into native scrolling without
 * delivering touchmove/touchend, so it cannot exercise long-press dragging.
 */
export async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, opts: { holdMs?: number; steps?: number } = {}) {
  await page.evaluate(
    async ({ from, to, holdMs, steps }) => {
      const target = document.elementFromPoint(from.x, from.y);
      if (!target) throw new Error('nothing under the finger');
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const touch = (x: number, y: number) => new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x + window.scrollX, pageY: y + window.scrollY, screenX: x, screenY: y, radiusX: 4, radiusY: 4, force: 1 });
      const fire = (type: string, x: number, y: number) => {
        const t = touch(x, y);
        const active = type === 'touchend' ? [] : [t];
        target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, composed: true, touches: active, targetTouches: active, changedTouches: [t] }));
      };
      fire('touchstart', from.x, from.y);
      if (holdMs) await sleep(holdMs);
      for (let i = 1; i <= steps; i++) {
        fire('touchmove', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
        await sleep(16);
      }
      fire('touchend', to.x, to.y);
    },
    { from, to, holdMs: opts.holdMs ?? 0, steps: opts.steps ?? 12 },
  );
}

/**
 * A touch along a path of points (touchstart at the first, touchend at the
 * last), waiting `wait` ms before each move with the finger still down.
 */
export async function touchPath(page: Page, points: { x: number; y: number; wait?: number }[]) {
  await page.evaluate(async (points) => {
    const target = document.elementFromPoint(points[0].x, points[0].y);
    if (!target) throw new Error('nothing under the finger');
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const fire = (type: string, x: number, y: number) => {
      const t = new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x + window.scrollX, pageY: y + window.scrollY, screenX: x, screenY: y, radiusX: 4, radiusY: 4, force: 1 });
      const active = type === 'touchend' ? [] : [t];
      target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, composed: true, touches: active, targetTouches: active, changedTouches: [t] }));
    };
    fire('touchstart', points[0].x, points[0].y);
    for (const p of points.slice(1)) {
      await sleep(p.wait ?? 16);
      fire('touchmove', p.x, p.y);
    }
    await sleep(16);
    const last = points[points.length - 1];
    fire('touchend', last.x, last.y);
  }, points);
}

/** Talk to the mock's HA websocket directly (to simulate changes made in HA). */
export async function haCommand(msg: Record<string, unknown>): Promise<any> {
  const ws = new WebSocket(`${MOCK_URL.replace('http', 'ws')}/api/websocket`);
  return new Promise((resolve, reject) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: 'mock-token' }));
      else if (m.type === 'auth_ok') ws.send(JSON.stringify({ id: 1, ...msg }));
      else if (m.id === 1) {
        ws.close();
        m.success ? resolve(m.result) : reject(new Error(m.error?.message));
      }
    };
    ws.onerror = () => reject(new Error('ws error'));
  });
}

export async function notifications(): Promise<any[]> {
  return (await fetch(`${MOCK_URL}/mock/notifications`)).json();
}
