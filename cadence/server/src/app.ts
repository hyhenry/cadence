import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { AppConfig } from './config.ts';
import { HaClient } from './ha/client.ts';
import { LiveHub } from './live.ts';
import { mockAwareFetcher, type Fetcher } from './links/validate.ts';
import { ReminderScheduler } from './reminders/scheduler.ts';
import { calendarRoutes } from './routes/calendars.ts';
import type { Ctx } from './routes/context.ts';
import { eventRoutes } from './routes/events.ts';
import { reminderRoutes } from './routes/reminders.ts';
import { Store } from './store/db.ts';

export const VERSION = '0.1.0';

export interface BuildOptions {
  config: AppConfig;
  /** Pino destination for tests (to assert that no secrets are logged). */
  logStream?: { write(s: string): void };
  logLevel?: string;
  fetcher?: Fetcher;
  dbFile?: string;
  startBackground?: boolean;
}

export interface App {
  app: FastifyInstance;
  ctx: Ctx;
  close(): Promise<void>;
}

export async function buildApp(opts: BuildOptions): Promise<App> {
  const { config } = opts;
  const app = Fastify({
    logger: {
      level: opts.logLevel ?? process.env.LOG_LEVEL ?? 'info',
      ...(opts.logStream ? { stream: opts.logStream } : {}),
      // Belt and braces: never serialise auth headers or bodies.
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'body', 'req.body', 'url', 'token'], censor: '[redacted]' },
      serializers: {
        req: (req) => ({ method: req.method, path: String(req.url).split('?')[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 256 * 1024,
    trustProxy: false,
  });

  const log = {
    info: (m: string) => app.log.info(m),
    warn: (m: string) => app.log.warn(m),
    error: (m: string) => app.log.error(m),
  };

  const store = new Store(opts.dbFile ?? path.join(config.dataDir, 'cadence.db'));
  const ha = new HaClient(config.ha, log);
  const scheduler = new ReminderScheduler({
    store,
    listCalendars: () => ha.listCalendars(),
    getEvents: (id, s, e) => ha.getEvents(id, s, e),
    timeZone: () => ha.timeZone(),
    notify: (t, title, message) => ha.notify(t, title, message),
    log,
  });
  const live = new LiveHub(ha, store, scheduler, log);
  const ctx: Ctx = { config, ha, store, live, scheduler, fetcher: opts.fetcher ?? mockAwareFetcher(config.mockUrl) };

  // Behind Ingress only the Supervisor's proxy may connect.
  if (config.allowedIps) {
    const allowed = new Set(config.allowedIps);
    app.addHook('onRequest', async (req, reply) => {
      if (!allowed.has(req.socket.remoteAddress ?? '')) {
        reply.code(403).send({ error: 'forbidden', message: 'Open Calendar from the Home Assistant sidebar.' });
      }
    });
  }

  app.addHook('onResponse', async (req, reply) => {
    if (req.url.startsWith('/api/') && req.url !== '/api/stream') {
      req.log.info(`${req.method} ${req.url.split('?')[0]} ${reply.statusCode} ${Math.round(reply.elapsedTime)}ms`);
    }
  });

  app.get('/api/info', async () => {
    let cfg = null;
    try {
      cfg = await ha.config();
    } catch {
      /* HA unreachable */
    }
    return {
      version: VERSION,
      mode: config.ha.mode,
      connected: ha.socket.connected,
      ha_version: cfg?.version ?? ha.socket.haVersion,
      time_zone: cfg?.time_zone ?? 'UTC',
      location_name: cfg?.location_name ?? null,
      remote_calendar: cfg ? (cfg.components?.includes('remote_calendar') ?? true) || versionAtLeast(cfg.version, 2025, 4) : null,
    };
  });

  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    live.addClient(res);
  });

  calendarRoutes(app, ctx);
  eventRoutes(app, ctx);
  reminderRoutes(app, ctx);

  // Static front end. Paths in index.html are relative so this works under the Ingress prefix.
  const indexFile = path.join(config.webDist, 'index.html');
  if (existsSync(indexFile)) {
    const indexHtml = readFileSync(indexFile, 'utf8');
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/', index: false, wildcard: true, cacheControl: true, maxAge: '7d', immutable: true });
    const sendIndex = (_req: unknown, reply: any) => reply.header('cache-control', 'no-cache').type('text/html').send(indexHtml);
    app.get('/', sendIndex);
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found', message: 'Unknown API route' });
      return sendIndex(req, reply);
    });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/html').send('<p>Cadence server is running. The web app is served by Vite in development (<code>npm run dev</code>, port 5173).</p>'));
  }

  if (opts.startBackground !== false) {
    ha.start().catch(() => undefined);
    live.start();
    scheduler.start();
  }

  return {
    app,
    ctx,
    async close() {
      scheduler.stop();
      live.stop();
      ha.close();
      await app.close();
      store.close();
    },
  };
}

function versionAtLeast(v: string | undefined, major: number, minor: number): boolean {
  const m = /^(\d+)\.(\d+)/.exec(v ?? '');
  if (!m) return false;
  return Number(m[1]) > major || (Number(m[1]) === major && Number(m[2]) >= minor);
}
