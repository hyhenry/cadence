// Home Assistant websocket client: auth handshake, id-matched requests,
// subscriptions that survive reconnects, exponential backoff.
import { EventEmitter } from 'node:events';

export class HaError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'HaError';
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

interface Sub {
  msg: Record<string, unknown>;
  onEvent: (event: any) => void;
  /** Current server-side id; changes on every reconnect. */
  id: number | null;
  active: boolean;
}

export interface Subscription {
  unsubscribe(): Promise<void>;
}

export interface HaSocketOptions {
  url: string;
  token: string;
  requestTimeoutMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export class HaSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private subs = new Set<Sub>();
  private subById = new Map<number, Sub>();
  private ready: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private backoff = 1000;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  connected = false;
  haVersion: string | null = null;
  private readonly opts: HaSocketOptions;

  constructor(opts: HaSocketOptions) {
    super();
    this.opts = opts;
  }

  private log(level: 'info' | 'warn' | 'error', msg: string) {
    this.opts.log?.(level, msg);
  }

  start(): Promise<void> {
    this.closed = false;
    this.ensureReady();
    this.open();
    return this.ready!;
  }

  private ensureReady() {
    if (!this.ready) {
      this.ready = new Promise((r) => (this.readyResolve = r));
    }
  }

  private open() {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (err) {
      this.log('error', `websocket open failed: ${(err as Error).message}`);
      return this.scheduleReconnect();
    }
    this.ws = ws;
    ws.addEventListener('message', (ev) => this.onMessage(String(ev.data)));
    ws.addEventListener('close', () => this.onClose());
    ws.addEventListener('error', () => {
      /* close follows */
    });
  }

  private onMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) this.handle(m);
  }

  private handle(m: any) {
    switch (m.type) {
      case 'auth_required':
        this.ws?.send(JSON.stringify({ type: 'auth', access_token: this.opts.token }));
        return;
      case 'auth_ok':
        this.haVersion = m.ha_version ?? null;
        this.connected = true;
        this.backoff = 1000;
        this.log('info', `connected to Home Assistant websocket (HA ${this.haVersion ?? '?'})`);
        this.resubscribe();
        this.startPing();
        this.readyResolve?.();
        this.emit('connected');
        return;
      case 'auth_invalid':
        this.log('error', 'Home Assistant rejected the access token');
        this.emit('auth_invalid');
        return;
      case 'result': {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.success) p.resolve(m.result);
        else p.reject(new HaError(m.error?.code ?? 'unknown_error', m.error?.message ?? 'Unknown error'));
        return;
      }
      case 'pong': {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          clearTimeout(p.timer);
          p.resolve(null);
        }
        return;
      }
      case 'event': {
        const sub = this.subById.get(m.id);
        if (sub?.active) {
          try {
            sub.onEvent(m.event);
          } catch (err) {
            this.log('error', `subscription handler failed: ${(err as Error).message}`);
          }
        }
        return;
      }
    }
  }

  private onClose() {
    const wasConnected = this.connected;
    this.connected = false;
    this.ws = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new HaError('connection_lost', 'Connection to Home Assistant lost'));
    }
    this.pending.clear();
    this.subById.clear();
    for (const s of this.subs) s.id = null;
    if (wasConnected) {
      this.log('warn', 'Home Assistant websocket closed; reconnecting');
      this.ready = null;
      this.ensureReady();
      this.emit('disconnected');
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping' }).catch(() => this.ws?.close());
    }, 30_000);
    this.pingTimer.unref();
  }

  private resubscribe() {
    for (const s of this.subs) if (s.active) this.sendSub(s).catch(() => undefined);
  }

  private async sendSub(s: Sub) {
    const id = this.nextId++;
    s.id = id;
    this.subById.set(id, s);
    try {
      await this.raw({ ...s.msg, id });
    } catch (err) {
      this.subById.delete(id);
      s.id = null;
      this.log('warn', `subscription ${String(s.msg.type)} failed: ${(err as Error).message}`);
      throw err;
    }
  }

  private raw(msg: Record<string, unknown> & { id: number }): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) return reject(new HaError('not_connected', 'Not connected to Home Assistant'));
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new HaError('timeout', `Home Assistant did not answer ${String(msg.type)}`));
      }, this.opts.requestTimeoutMs ?? 30_000);
      this.pending.set(msg.id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(msg));
    });
  }

  /** Send a command and await its result. Waits for (re)connection up to the request timeout. */
  async send<T = unknown>(msg: Record<string, unknown>): Promise<T> {
    if (!this.connected) await this.waitReady();
    return (await this.raw({ ...msg, id: this.nextId++ })) as T;
  }

  private async waitReady() {
    this.ensureReady();
    const t = this.opts.requestTimeoutMs ?? 30_000;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.ready,
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new HaError('not_connected', 'Not connected to Home Assistant')), t);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /** Subscribe; the subscription is re-established automatically after a reconnect. */
  async subscribe(msg: Record<string, unknown>, onEvent: (event: any) => void): Promise<Subscription> {
    const s: Sub = { msg, onEvent, id: null, active: true };
    this.subs.add(s);
    if (this.connected) {
      try {
        await this.sendSub(s);
      } catch (err) {
        this.subs.delete(s);
        throw err;
      }
    }
    return {
      unsubscribe: async () => {
        s.active = false;
        this.subs.delete(s);
        const id = s.id;
        if (id != null) {
          this.subById.delete(id);
          if (this.connected) await this.send({ type: 'unsubscribe_events', subscription: id }).catch(() => undefined);
        }
      },
    };
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }
}
