import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startMockHA, type RunningMock } from '../../../dev/mock-ha/src/server.ts';
import { buildApp, type App } from '../src/app.ts';
import type { AppConfig } from '../src/config.ts';
import { mockAwareFetcher } from '../src/links/validate.ts';

export interface Harness {
  mock: RunningMock;
  app: App;
  logs: string[];
  inject: App['app']['inject'];
  close(): Promise<void>;
}

export async function startHarness(opts: { seed?: boolean; debounceMs?: number; background?: boolean } = {}): Promise<Harness> {
  const mock = await startMockHA({ port: 0, quiet: true, seed: opts.seed, debounceMs: opts.debounceMs ?? 50, tz: 'America/Toronto' });
  const dir = mkdtempSync(path.join(tmpdir(), 'cadence-test-'));
  const config: AppConfig = {
    ha: { mode: 'mock', restBase: `${mock.url}/api`, wsUrl: `${mock.url.replace('http', 'ws')}/api/websocket`, token: 'mock-token' },
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    webDist: path.join(dir, 'no-web'),
    allowedIps: null,
    mockUrl: mock.url,
  };
  const logs: string[] = [];
  const app = await buildApp({ config, logStream: { write: (s) => void logs.push(s) }, logLevel: 'debug', fetcher: mockAwareFetcher(mock.url), startBackground: false });
  await app.ctx.ha.start();
  if (opts.background) {
    app.ctx.live.start();
  }
  return {
    mock,
    app,
    logs,
    inject: app.app.inject.bind(app.app),
    async close() {
      await app.close();
      await mock.close();
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(fn: () => T | Promise<T>, timeoutMs = 4000, stepMs = 25): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await fn();
    if (last) return last;
    await sleep(stepMs);
  } while (Date.now() < end);
  throw new Error('condition not met in time');
}
