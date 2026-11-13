import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/app.ts';
import { describeTarget, resolveHaTarget } from '../src/config.ts';

const noEnv = { CADENCE_ENV_FILE: '/nonexistent/.env' };

test('SUPERVISOR_TOKEN wins and points at the supervisor proxy', () => {
  const t = resolveHaTarget({ ...noEnv, SUPERVISOR_TOKEN: 'sup', HA_URL: 'http://x:8123', HA_TOKEN: 'y' });
  assert.equal(t.mode, 'supervisor');
  assert.equal(t.restBase, 'http://supervisor/core/api');
  assert.equal(t.wsUrl, 'ws://supervisor/core/websocket');
  assert.equal(t.token, 'sup');
});

test('HA_URL/HA_TOKEN from the environment', () => {
  const t = resolveHaTarget({ ...noEnv, HA_URL: 'https://ha.example:8123/', HA_TOKEN: 'abc' });
  assert.equal(t.mode, 'env');
  assert.equal(t.restBase, 'https://ha.example:8123/api');
  assert.equal(t.wsUrl, 'wss://ha.example:8123/api/websocket');
});

test('.env file is read without mutating process.env', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cadence-env-'));
  const f = path.join(dir, '.env');
  writeFileSync(f, 'HA_URL=http://ha.lan:8123\nHA_TOKEN=secret-token\n');
  const t = resolveHaTarget({ CADENCE_ENV_FILE: f });
  assert.equal(t.mode, 'env');
  assert.equal(t.token, 'secret-token');
  assert.equal(process.env.HA_TOKEN, undefined);
});

test('an .env with an empty token falls back to the mock', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cadence-env-'));
  const f = path.join(dir, '.env');
  writeFileSync(f, 'HA_URL=http://ha.lan:8123\nHA_TOKEN=\n');
  assert.equal(resolveHaTarget({ CADENCE_ENV_FILE: f }).mode, 'mock');
});

test('defaults to the mock', () => {
  const t = resolveHaTarget(noEnv);
  assert.equal(t.mode, 'mock');
  assert.equal(t.restBase, 'http://127.0.0.1:8124/api');
});

test('describeTarget never includes the token', () => {
  for (const t of [resolveHaTarget({ ...noEnv, SUPERVISOR_TOKEN: 'tok-1' }), resolveHaTarget({ ...noEnv, HA_URL: 'http://h:1', HA_TOKEN: 'tok-2' })]) {
    assert.ok(!describeTarget(t).includes('tok-'));
  }
});

test('production (Supervisor) settings: /data, all interfaces, Ingress-only', async () => {
  const { loadConfig } = await import('../src/config.ts');
  const c = loadConfig({ ...noEnv, SUPERVISOR_TOKEN: 'x' });
  assert.equal(c.dataDir, '/data');
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.port, 8099);
  assert.ok(c.allowedIps?.includes('172.30.32.2'));
  assert.equal(c.mockUrl, null);
});

test('only the Ingress proxy may connect in production', async () => {
  const { buildApp } = await import('../src/app.ts');
  const { loadConfig } = await import('../src/config.ts');
  const dir = mkdtempSync(path.join(tmpdir(), 'cadence-prod-'));
  const config = { ...loadConfig({ ...noEnv, SUPERVISOR_TOKEN: 'x' }), dataDir: dir };
  const app = await buildApp({ config, logStream: { write: () => undefined }, startBackground: false });
  try {
    const denied = await app.app.inject({ method: 'GET', url: '/api/settings', remoteAddress: '192.168.1.50' });
    assert.equal(denied.statusCode, 403);
    const ok = await app.app.inject({ method: 'GET', url: '/api/settings', remoteAddress: '172.30.32.2' });
    assert.equal(ok.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('the version shown in the app matches the version in config.yaml', () => {
  const yaml = readFileSync(fileURLToPath(new URL('../../config.yaml', import.meta.url)), 'utf8');
  assert.equal(VERSION, /^version:\s*"?([^"\s]+)"?/m.exec(yaml)?.[1]);
});
