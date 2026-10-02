import WebSocket from 'ws';

/**
 * A minimal Chrome DevTools Protocol client over one page target's WebSocket (#781). Raw CDP never
 * leaves the server process: the preview host wraps this behind its own whitelisted vocabulary.
 */
export interface Cdp {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Subscribe to a CDP event; returns the unsubscribe. */
  on<T = unknown>(event: string, fn: (params: T) => void): () => void;
  close(): void;
  /** Settles when the socket is gone, whoever closed it. */
  closed: Promise<void>;
}

type Pending = { resolve: (value: never) => void; reject: (err: Error) => void; method: string };

export function connectCdp(wsUrl: string): Promise<Cdp> {
  return new Promise((resolveConnect, rejectConnect) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    let nextId = 0;
    let isClosed = false;
    const pending = new Map<number, Pending>();
    const listeners = new Map<string, Set<(params: never) => void>>();
    let markClosed!: () => void;
    const closed = new Promise<void>(resolve => (markClosed = resolve));

    ws.on('message', raw => {
      let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (typeof msg.id === 'number') {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        if (!entry) return;
        if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message ?? 'CDP error'}`));
        else entry.resolve(msg.result as never);
      } else if (msg.method) {
        for (const fn of listeners.get(msg.method) ?? []) fn(msg.params as never);
      }
    });

    ws.once('open', () =>
      resolveConnect({
        send: <T>(method: string, params: Record<string, unknown> = {}) =>
          new Promise<T>((resolve, reject) => {
            if (isClosed || ws.readyState !== WebSocket.OPEN) return reject(new Error(`${method}: CDP connection closed`));
            const id = ++nextId;
            pending.set(id, { resolve: resolve as (value: never) => void, reject, method });
            ws.send(JSON.stringify({ id, method, params }), err => {
              if (!err) return;
              pending.delete(id);
              reject(new Error(`${method}: ${err.message}`));
            });
          }),
        on: <T>(event: string, fn: (params: T) => void) => {
          const set = listeners.get(event) ?? new Set();
          listeners.set(event, set);
          set.add(fn as (params: never) => void);
          return () => void set.delete(fn as (params: never) => void);
        },
        close: () => ws.close(),
        closed,
      }),
    );
    // Before `open` an error is the connect failure; afterwards `close` follows and does the cleanup.
    ws.once('error', err => rejectConnect(err));
    ws.on('error', () => {});
    ws.once('close', () => {
      isClosed = true;
      for (const entry of pending.values()) entry.reject(new Error(`${entry.method}: CDP connection closed`));
      pending.clear();
      listeners.clear();
      markClosed();
    });
  });
}
