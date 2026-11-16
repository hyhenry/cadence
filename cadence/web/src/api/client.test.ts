import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const { api, ApiError, onSessionChange, SESSION_RETRY_MS } = await import('./client.ts');

// What HA Ingress answers once the ingress_session cookie has lapsed.
const ingress401 = () => new Response('401: Unauthorized', { status: 401, headers: { 'content-type': 'text/plain' } });
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

let replies: (() => Response)[] = [];
let calls = 0;

beforeEach(() => {
  replies = [];
  calls = 0;
  mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.fetch = (async () => {
    calls++;
    const next = replies.length > 1 ? replies.shift()! : replies[0];
    return next();
  }) as typeof fetch;
});
afterEach(() => mock.timers.reset());

/** Let pending promises settle, then move the fake clock on. */
async function advance(ms: number) {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  mock.timers.tick(ms);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

test('a request turned away by Ingress is retried until HA renews the session', async () => {
  replies = [ingress401, ingress401, () => ok({ settings: { week_start: 1 } })];
  const changes: boolean[] = [];
  const off = onSessionChange((e) => changes.push(e));
  const p = api.settings();
  await advance(SESSION_RETRY_MS[0]);
  await advance(SESSION_RETRY_MS[1]);
  assert.deepEqual(await p, { week_start: 1 });
  assert.equal(calls, 3);
  assert.deepEqual(changes, [], 'a renewal in time is not reported');
  off();
});

test('a session that stays gone ends in session_expired, and recovers on the next success', async () => {
  replies = [ingress401];
  const changes: boolean[] = [];
  const off = onSessionChange((e) => changes.push(e));
  const p = api.settings().catch((e) => e);
  for (const ms of SESSION_RETRY_MS) await advance(ms);
  const err = await p;
  assert.ok(err instanceof ApiError);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'session_expired');
  assert.equal(calls, SESSION_RETRY_MS.length + 1);
  assert.deepEqual(changes, [true]);

  // Once given up, the next request fails straight away instead of waiting again.
  calls = 0;
  await assert.rejects(api.settings(), (e: InstanceType<typeof ApiError>) => e.code === 'session_expired');
  assert.equal(calls, 1);

  // HA renewed the session after all (or the page was reloaded).
  replies = [() => ok({ settings: {} })];
  await api.settings();
  assert.deepEqual(changes, [true, false]);
  off();
});

test('other errors are not retried', async () => {
  replies = [() => new Response(JSON.stringify({ error: 'ha_unavailable', message: 'down' }), { status: 503 })];
  await assert.rejects(api.settings(), (e: InstanceType<typeof ApiError>) => e.status === 503 && e.code === 'ha_unavailable');
  assert.equal(calls, 1);
});
