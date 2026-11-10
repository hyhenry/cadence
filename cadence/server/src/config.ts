import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type HaMode = 'supervisor' | 'env' | 'mock';

export interface HaTarget {
  mode: HaMode;
  /** Base for REST calls, e.g. http://supervisor/core/api (no trailing slash). */
  restBase: string;
  wsUrl: string;
  token: string;
}

export interface AppConfig {
  ha: HaTarget;
  port: number;
  host: string;
  dataDir: string;
  webDist: string;
  /** Only these client IPs may connect (production behind Ingress); null = no restriction. */
  allowedIps: string[] | null;
  /** In mock mode, share-link hosts are routed to the mock's fake feeds. */
  mockUrl: string | null;
}

const here = path.dirname(fileURLToPath(import.meta.url));

function findEnvFile(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const f = path.join(dir, '.env');
    if (existsSync(f)) return f;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function stripSlash(u: string): string {
  return u.replace(/\/+$/, '');
}

/**
 * Token resolution order:
 *   1. SUPERVISOR_TOKEN (running as a HA app) -> http://supervisor/core
 *   2. HA_URL + HA_TOKEN from the environment or an optional git-ignored .env
 *   3. dev/mock-ha on localhost
 */
export function resolveHaTarget(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): HaTarget {
  if (env.SUPERVISOR_TOKEN) {
    return { mode: 'supervisor', restBase: 'http://supervisor/core/api', wsUrl: 'ws://supervisor/core/websocket', token: env.SUPERVISOR_TOKEN };
  }
  let haUrl = env.HA_URL;
  let haToken = env.HA_TOKEN;
  if (!haUrl || !haToken) {
    const envFile = env.CADENCE_ENV_FILE ?? findEnvFile(cwd);
    if (envFile && existsSync(envFile)) {
      // process.loadEnvFile would mutate process.env; parse into a copy instead.
      const parsed = parseEnv(readFileSync(envFile, 'utf8')) as Record<string, string | undefined>;
      haUrl ??= parsed.HA_URL;
      haToken ??= parsed.HA_TOKEN;
    }
  }
  if (haUrl && haToken) {
    const base = stripSlash(haUrl);
    return { mode: 'env', restBase: `${base}/api`, wsUrl: `${base.replace(/^http/, 'ws')}/api/websocket`, token: haToken };
  }
  const mock = stripSlash(env.MOCK_HA_URL ?? 'http://127.0.0.1:8124');
  return { mode: 'mock', restBase: `${mock}/api`, wsUrl: `${mock.replace(/^http/, 'ws')}/api/websocket`, token: env.MOCK_HA_TOKEN ?? 'mock-token' };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const ha = resolveHaTarget(env);
  const production = ha.mode === 'supervisor';
  return {
    ha,
    port: Number(env.CADENCE_PORT ?? 8099),
    host: env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1'),
    dataDir: env.CADENCE_DATA_DIR ?? (production ? '/data' : path.resolve(here, '../../../.data')),
    webDist: env.CADENCE_WEB_DIST ?? path.resolve(here, '../../web/dist'),
    allowedIps: production ? ['172.30.32.2', '127.0.0.1', '::1', '::ffff:172.30.32.2', '::ffff:127.0.0.1'] : null,
    mockUrl: ha.mode === 'mock' ? ha.restBase.replace(/\/api$/, '') : null,
  };
}

/** Safe description of the target for logs: never includes the token. */
export function describeTarget(t: HaTarget): string {
  if (t.mode === 'supervisor') return 'Home Assistant via Supervisor';
  if (t.mode === 'env') return `Home Assistant at ${new URL(t.restBase).host} (from HA_URL)`;
  return `mock Home Assistant at ${new URL(t.restBase).host}`;
}
