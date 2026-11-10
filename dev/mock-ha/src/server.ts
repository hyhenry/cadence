// HTTP + WebSocket front for MockHA. REST paths, WS message formats and error
// codes mirror Home Assistant core. Also serves an ingress-like proxy at
// /api/hassio_ingress/<token>/ so Cadence can be tested under a sub-path.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DateTime } from 'luxon';
import { WebSocketServer, type WebSocket } from 'ws';
import { NotFoundError, parseEventInput, toApiEvent, toDictEvent, ValidationError } from './calendar.ts';
import { fakeRemote } from './ics.ts';
import { FEATURE_CREATE, FEATURE_DELETE, FEATURE_UPDATE, FlowError, MockHA } from './ha.ts';

export interface MockOptions {
  port?: number;
  host?: string;
  tz?: string;
  token?: string;
  debounceMs?: number;
  seed?: boolean;
  /** Where /api/hassio_ingress/<token>/ forwards to (the Cadence server). */
  ingressTarget?: string;
  quiet?: boolean;
}

export interface RunningMock {
  url: string;
  ha: MockHA;
  close(): Promise<void>;
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new FlowError(400, { message: 'Invalid JSON.' });
  }
}

function parseDt(v: string | null, tz: string): DateTime | null {
  if (!v) return null;
  const d = DateTime.fromISO(v, { zone: tz });
  return d.isValid ? d : null;
}

export async function startMockHA(opts: MockOptions = {}): Promise<RunningMock> {
  const tz = opts.tz ?? process.env.MOCK_TZ ?? 'America/Toronto';
  const token = opts.token ?? 'mock-token';
  const ha = new MockHA({ tz, debounceMs: opts.debounceMs });
  if (opts.seed !== false) await ha.seed();
  const log = (...a: unknown[]) => {
    if (!opts.quiet) console.log('[mock-ha]', ...a);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const p = url.pathname;
    try {
      // ---- ingress simulation (no bearer; HA would use its session cookie) ----
      const ing = /^\/api\/hassio_ingress\/([^/]+)(\/.*)?$/.exec(p);
      if (ing) {
        if (!opts.ingressTarget) return send(res, 502, { message: 'no ingress target' });
        if (!ing[2]) {
          res.writeHead(307, { location: `${p}/` });
          return res.end();
        }
        const target = new URL(ing[2] + url.search, opts.ingressTarget);
        const headers = { ...req.headers, host: target.host, 'x-ingress-path': `/api/hassio_ingress/${ing[1]}` };
        const preq = http.request(target, { method: req.method, headers }, (pres) => {
          res.writeHead(pres.statusCode ?? 502, pres.headers);
          pres.pipe(res);
        });
        preq.on('error', () => send(res, 502, { message: 'Bad gateway' }));
        req.pipe(preq);
        return;
      }

      // ---- mock control + fake remote hosts (no auth) ----
      if (p === '/mock/health') return send(res, 200, { ok: true });
      if (p === '/mock/ha-frame') {
        // Imitates the HA frontend: theme variables as inline styles on <html> and
        // the app in an iframe (same origin), as with Ingress. setTheme('dark'|'light')
        // switches like HA's profile setting does.
        const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
html,body{margin:0;height:100%;background:var(--primary-background-color)}iframe{border:0;width:100%;height:100%;display:block}
html{--primary-background-color:#fafafa;--card-background-color:#ffffff;--secondary-background-color:#e5e5e5;--primary-text-color:#212121;--secondary-text-color:#727272;--divider-color:rgba(0,0,0,.12);--primary-color:#03a9f4;--text-primary-color:#ffffff;--error-color:#db4437}
</style><script>
const DARK={'--primary-background-color':'#111111','--card-background-color':'#1c1c1c','--secondary-background-color':'#282828','--primary-text-color':'#e1e1e1','--secondary-text-color':'#9b9b9b','--divider-color':'rgba(225,225,225,.12)','--primary-color':'#03a9f4','--text-primary-color':'#ffffff','--error-color':'#ff6b6b'};
window.setTheme=(mode)=>{const s=document.documentElement.style;for(const k of Object.keys(DARK)){if(mode==='dark')s.setProperty(k,DARK[k]);else s.removeProperty(k);}};
</script></head><body><script>setTheme(new URLSearchParams(location.search).get('theme')||'light')</script>
<iframe title="Calendar" src="/api/hassio_ingress/${(url.searchParams.get('token') ?? 'dev').replace(/[^a-z0-9_-]/gi, '')}/"></iframe></body></html>`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      if (p === '/mock/notifications') {
        if (req.method === 'DELETE') ha.notifications = [];
        return send(res, 200, ha.notifications);
      }
      if (p === '/mock/stats') return send(res, 200, { remoteFetches: ha.remoteFetches, serviceCalls: ha.serviceCalls });
      const fr = /^\/mock\/remote\/([^/]+)(\/.*)$/.exec(p);
      if (fr) {
        const fake = fakeRemote(new URL(`https://${fr[1]}${fr[2]}${url.search}`), tz);
        if (!fake) return send(res, 404, { message: 'unknown fake host' });
        res.writeHead(fake.status, { 'content-type': fake.contentType, ...(fake.headers ?? {}) });
        return res.end(fake.body);
      }

      if (!p.startsWith('/api/')) return send(res, 404, { message: 'Not found' });
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        return res.end('401: Unauthorized');
      }
      const m = req.method ?? 'GET';
      if (p === '/api/' && m === 'GET') return send(res, 200, { message: 'API running.' });
      if (p === '/api/config' && m === 'GET') return send(res, 200, ha.config());
      if (p === '/api/states' && m === 'GET') return send(res, 200, ha.states());
      let mm;
      if ((mm = /^\/api\/states\/(.+)$/.exec(p)) && m === 'GET') {
        const ent = ha.entities.get(mm[1]);
        return ent ? send(res, 200, ha.stateOf(ent)) : send(res, 404, { message: 'Entity not found.' });
      }
      if (p === '/api/calendars' && m === 'GET') {
        const list = [...ha.entities.values()].map((e) => ({ name: e.name, entity_id: e.entity_id })).sort((a, b) => a.name.localeCompare(b.name));
        return send(res, 200, list);
      }
      if ((mm = /^\/api\/calendars\/(.+)$/.exec(p)) && m === 'GET') {
        const ent = ha.entities.get(decodeURIComponent(mm[1]));
        if (!ent) {
          res.writeHead(400);
          return res.end();
        }
        const s = parseDt(url.searchParams.get('start'), tz);
        const e = parseDt(url.searchParams.get('end'), tz);
        if (!s || !e || s > e) {
          res.writeHead(400);
          return res.end();
        }
        return send(res, 200, ent.store.list(s, e).map(toApiEvent));
      }
      if (p === '/api/services' && m === 'GET') return send(res, 200, ha.services());
      if ((mm = /^\/api\/services\/([^/]+)\/([^/]+)$/.exec(p)) && m === 'POST') {
        const body = await readJson(req);
        return send(res, 200, await ha.callService(mm[1], mm[2], body));
      }
      if (p === '/api/config/config_entries/flow_handlers' && m === 'GET') return send(res, 200, ['local_calendar', 'remote_calendar', 'caldav', 'google']);
      if (p === '/api/config/config_entries/flow') {
        if (m !== 'POST') return send(res, 405, { message: 'Method Not Allowed' });
        return send(res, 200, ha.startFlow(await readJson(req)));
      }
      if ((mm = /^\/api\/config\/config_entries\/flow\/([^/]+)$/.exec(p))) {
        if (m === 'GET') return send(res, 200, ha.getFlow(mm[1]));
        if (m === 'DELETE') return send(res, 200, ha.deleteFlow(mm[1]));
        if (m === 'POST') return send(res, 200, await ha.submitFlow(mm[1], await readJson(req)));
      }
      if (p === '/api/config/config_entries/entry' && m === 'GET') {
        const domain = url.searchParams.get('domain');
        return send(res, 200, [...ha.entries.values()].filter((e) => !domain || e.domain === domain).map((e) => ha.entryJson(e)));
      }
      if ((mm = /^\/api\/config\/config_entries\/entry\/([^/]+)$/.exec(p)) && m === 'DELETE') {
        if (!ha.removeEntry(mm[1])) return send(res, 404, { message: 'Invalid entry specified' });
        return send(res, 200, { require_restart: false });
      }
      return send(res, 404, { message: 'Not found' });
    } catch (err) {
      if (err instanceof FlowError) return send(res, err.status, err.body);
      log('error', err);
      return send(res, 500, { message: String((err as Error).message) });
    }
  });

  // ---- websocket ----------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://mock').pathname !== '/api/websocket') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => handleWs(ws));
  });

  function handleWs(ws: WebSocket) {
    let authed = false;
    let lastId = 0;
    const subs = new Map<number, () => void>();
    const out = (msg: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    const result = (id: number, r: unknown = null) => out({ id, type: 'result', success: true, result: r });
    const error = (id: number, code: string, message: string) => out({ id, type: 'result', success: false, error: { code, message } });
    out({ type: 'auth_required', ha_version: ha.version });
    ws.on('close', () => {
      for (const u of subs.values()) u();
      subs.clear();
    });
    ws.on('message', async (buf) => {
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(String(buf));
      } catch {
        return ws.close();
      }
      if (!authed) {
        if (msg.type === 'auth' && msg.access_token === token) {
          authed = true;
          return out({ type: 'auth_ok', ha_version: ha.version });
        }
        out({ type: 'auth_invalid', message: 'Invalid access token or password' });
        return ws.close();
      }
      const msgs = Array.isArray(msg) ? msg : [msg];
      for (const m of msgs) await handle(m);
    });

    const calendarEntity = (id: number, entity_id: unknown) => {
      const ent = typeof entity_id === 'string' ? ha.entities.get(entity_id) : undefined;
      if (!ent) error(id, 'not_found', 'Entity not found');
      return ent;
    };

    async function handle(m: Record<string, any>) {
      const id = m.id;
      if (typeof id !== 'number') return error(0, 'invalid_format', 'Message incorrectly formatted.');
      if (id <= lastId) return error(id, 'id_reuse', 'Identifier values have to increase.');
      lastId = id;
      try {
        switch (m.type) {
          case 'ping':
            return out({ id, type: 'pong' });
          case 'get_config':
            return result(id, ha.config());
          case 'get_states':
            return result(id, ha.states());
          case 'config/entity_registry/list':
            return result(id, ha.entityRegistry());
          case 'subscribe_events': {
            const type = m.event_type as string | undefined;
            const unsub = ha.onBus((e) => {
              if (!type || e.event_type === type) out({ id, type: 'event', event: e });
            });
            subs.set(id, unsub);
            return result(id);
          }
          case 'unsubscribe_events': {
            const u = subs.get(m.subscription);
            if (!u) return error(id, 'not_found', 'Subscription not found.');
            u();
            subs.delete(m.subscription);
            return result(id);
          }
          case 'call_service': {
            const data = { ...(m.service_data ?? {}), ...(m.target ?? {}) };
            await ha.callService(m.domain, m.service, data);
            return result(id, { context: { id: 'ctx', parent_id: null, user_id: null }, response: null });
          }
          case 'calendar/event/create':
          case 'calendar/event/update':
          case 'calendar/event/delete': {
            const verb = m.type.split('/')[2] as 'create' | 'update' | 'delete';
            if (verb !== 'create' && typeof m.uid !== 'string') return error(id, 'invalid_format', "required key not provided @ data['uid']. Got None");
            if (verb !== 'delete' && m.event === undefined) return error(id, 'invalid_format', "required key not provided @ data['event']. Got None");
            const ent = calendarEntity(id, m.entity_id);
            if (!ent) return;
            const bit = { create: FEATURE_CREATE, update: FEATURE_UPDATE, delete: FEATURE_DELETE }[verb];
            if (!ent.supported_features || !(ent.supported_features & bit)) {
              const what = { create: 'event creation', update: 'event update', delete: 'event deletion' }[verb];
              return error(id, 'not_supported', `Calendar does not support ${what}`);
            }
            let input;
            if (verb !== 'delete') {
              try {
                input = parseEventInput(m.event, tz);
              } catch (err) {
                if (err instanceof ValidationError) return error(id, 'invalid_format', `${err.message}. Got ${JSON.stringify(m.event)}`);
                throw err;
              }
            }
            const rid = m.recurrence_id || null; // empty_as_none
            try {
              if (verb === 'create') ent.store.add(input!);
              else if (verb === 'update') ent.store.update(m.uid, input!, rid, m.recurrence_range ?? null);
              else ent.store.delete(m.uid, rid, m.recurrence_range ?? null);
            } catch (err) {
              if (err instanceof NotFoundError || err instanceof ValidationError) return error(id, 'failed', err.message);
              throw err;
            }
            ha.writeState(ent.entity_id);
            return result(id);
          }
          case 'calendar/event/subscribe': {
            if (typeof m.entity_id !== 'string' || !m.entity_id.startsWith('calendar.')) return error(id, 'invalid_format', 'Entity ID is an invalid entity ID');
            const ent = ha.entities.get(m.entity_id);
            if (!ent) return error(id, 'not_found', `Calendar entity not found: ${m.entity_id}`);
            const s = parseDt(m.start, tz);
            const e = parseDt(m.end, tz);
            if (!s || !e) return error(id, 'invalid_format', 'Invalid datetime');
            if (s >= e) return error(id, 'invalid_format', 'Start must be before end');
            const push = () => {
              const cur = ha.entities.get(ent.entity_id);
              out({ id, type: 'event', event: { events: cur ? cur.store.list(s, e).map(toDictEvent) : null } });
            };
            subs.set(id, ha.onCalendarWrite(ent.entity_id, push));
            result(id);
            setImmediate(push); // initial push to this subscriber only
            return;
          }
          default:
            return error(id, 'unknown_command', 'Unknown command.');
        }
      } catch (err) {
        if (err instanceof FlowError) return error(id, 'service_validation_error', String((err.body as any)?.message ?? 'error'));
        log('ws error', err);
        return error(id, 'unknown_error', String((err as Error).message));
      }
    }
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? 8124, opts.host ?? '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;
  log(`listening on ${url} (tz ${tz})`);
  return {
    url,
    ha,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
