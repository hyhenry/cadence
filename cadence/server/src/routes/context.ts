import type { FastifyReply } from 'fastify';
import type { AppConfig } from '../config.ts';
import { HaHttpError, type HaClient } from '../ha/client.ts';
import { HaError } from '../ha/ws.ts';
import type { LiveHub } from '../live.ts';
import type { Fetcher } from '../links/validate.ts';
import type { ReminderScheduler } from '../reminders/scheduler.ts';
import type { Store } from '../store/db.ts';

export interface Ctx {
  config: AppConfig;
  ha: HaClient;
  store: Store;
  live: LiveHub;
  scheduler: ReminderScheduler;
  fetcher: Fetcher;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Map HA errors to API responses with messages people can act on. Never echoes request bodies. */
export function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof ApiError) return reply.code(err.status).send({ error: err.code, message: err.message });
  if (err instanceof HaError) {
    const status = err.code === 'not_connected' || err.code === 'connection_lost' || err.code === 'cannot_connect' || err.code === 'timeout' ? 503 : err.code === 'not_found' ? 404 : 400;
    const message =
      status === 503
        ? 'Home Assistant is not reachable right now. Try again in a moment.'
        : err.code === 'not_supported'
          ? 'This calendar does not allow that change.'
          : err.message;
    return reply.code(status).send({ error: err.code, message });
  }
  if (err instanceof HaHttpError) {
    if (err.status === 401 || err.status === 403) return reply.code(502).send({ error: 'ha_forbidden', message: 'Home Assistant refused the request (the calendar app needs admin access to the Home Assistant API).' });
    const msg = typeof err.body === 'object' && err.body && 'message' in err.body ? String((err.body as any).message) : err.message;
    return reply.code(502).send({ error: 'ha_error', message: msg });
  }
  reply.log.error({ err: { message: (err as Error)?.message, name: (err as Error)?.name } }, 'unexpected error');
  return reply.code(500).send({ error: 'internal', message: 'Something went wrong in the calendar app.' });
}

export function str(v: unknown, field: string, max = 500): string {
  if (typeof v !== 'string' || !v.trim()) throw new ApiError(400, 'invalid_request', `${field} is required`);
  if (v.length > max) throw new ApiError(400, 'invalid_request', `${field} is too long`);
  return v.trim();
}
