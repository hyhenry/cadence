import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// A stand-in for the browser's EventSource, just enough for subscribeLive.
class FakeSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static all: FakeSource[] = [];
  readyState = FakeSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (ev: { data: string }) => void>();
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSource.all.push(this);
  }
  addEventListener(type: string, fn: (ev: { data: string }) => void) {
    this.listeners.set(type, fn);
  }
  close() {
    this.readyState = FakeSource.CLOSED;
  }
  open() {
    this.readyState = FakeSource.OPEN;
    this.onopen?.();
  }
  /** What the browser does when a reconnect gets a 502: give up for good. */
  fail() {
    this.readyState = FakeSource.CLOSED;
    this.onerror?.();
  }
  /** A dropped connection the browser will retry by itself. */
  drop() {
    this.readyState = FakeSource.CONNECTING;
    this.onerror?.();
  }
}

const doc = new EventTarget() as EventTarget & { visibilityState: string };
doc.visibilityState = 'visible';
const win = new EventTarget();

beforeEach(() => {
  FakeSource.all = [];
  mock.timers.enable({ apis: ['setTimeout'] });
  Object.assign(globalThis, { EventSource: FakeSource, document: doc, window: win });
});
afterEach(() => mock.timers.reset());

const { subscribeLive } = await import('./client.ts');

test('a stream the browser gave up on is rebuilt, and the status recovers', () => {
  const status: boolean[] = [];
  const stop = subscribeLive(() => {}, (ok) => status.push(ok));
  FakeSource.all[0].open();
  FakeSource.all[0].fail();
  assert.deepEqual(status, [true, false]);
  assert.equal(FakeSource.all.length, 1);
  mock.timers.tick(3000);
  assert.equal(FakeSource.all.length, 2);
  FakeSource.all[1].open();
  assert.deepEqual(status, [true, false, true]);
  stop();
});

test('backs off while it keeps failing, then resets after a success', () => {
  const stop = subscribeLive(() => {});
  FakeSource.all[0].fail();
  mock.timers.tick(3000);
  FakeSource.all[1].fail();
  mock.timers.tick(5999);
  assert.equal(FakeSource.all.length, 2);
  mock.timers.tick(1);
  assert.equal(FakeSource.all.length, 3);
  FakeSource.all[2].open();
  FakeSource.all[2].fail();
  mock.timers.tick(3000);
  assert.equal(FakeSource.all.length, 4);
  stop();
});

test('leaves a dropped connection to the browser to retry', () => {
  const stop = subscribeLive(() => {});
  FakeSource.all[0].open();
  FakeSource.all[0].drop();
  mock.timers.tick(60_000);
  assert.equal(FakeSource.all.length, 1);
  stop();
});

test('coming back to the page reconnects at once', () => {
  const stop = subscribeLive(() => {});
  FakeSource.all[0].fail();
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(FakeSource.all.length, 2);
  mock.timers.tick(3000);
  assert.equal(FakeSource.all.length, 2, 'the pending retry was replaced, not doubled');
  stop();
});

test('stopping cancels a pending retry', () => {
  const stop = subscribeLive(() => {});
  FakeSource.all[0].fail();
  stop();
  mock.timers.tick(60_000);
  win.dispatchEvent(new Event('online'));
  assert.equal(FakeSource.all.length, 1);
});
