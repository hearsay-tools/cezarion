import type { Readable, Writable } from 'node:stream';
import WebSocket from 'ws';

/**
 * A minimal Chrome DevTools Protocol client (hearsay-tools/cezarion#781). Raw CDP never leaves the server process except
 * through the agent's CDP proxy (`cdp-proxy.ts`, hearsay-tools/cezarion#784), which gives each agent
 * connection its own browser session on this same connection.
 */
export interface Cdp {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Subscribe to a CDP event; returns the unsubscribe. */
  on<T = unknown>(event: string, fn: (params: T) => void): () => void;
  close(): void;
  /** Settles when the connection is gone, whoever closed it. */
  closed: Promise<void>;
}

/** One CDP message as it crosses the wire. Flat sessions name their session in `sessionId`. */
export type CdpMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  sessionId?: string;
};

/** The browser-level connection: flat sessions over one transport (the pipe, hearsay-tools/cezarion#784). */
export interface CdpConnection {
  /** A page or browser session's client. Undefined is the root session. */
  session(sessionId: string | undefined): Cdp;
  /** Sends one command and settles with its raw reply, error included: the proxy forwards it as it came. */
  call(method: string, params: unknown, sessionId: string | undefined): Promise<CdpMessage>;
  /** `call` with a callback run in wire order, before any message read after the reply: a proxy
   *  that forwards replies and events keeps the order the browser sent them in. */
  request(method: string, params: unknown, sessionId: string | undefined, onReply: (msg: CdpMessage) => void): void;
  /** Every event on every session, as it came; returns the unsubscribe. */
  onEvent(fn: (msg: CdpMessage) => void): () => void;
  close(): void;
  closed: Promise<void>;
}

/** What a connection needs of its wire: send one message, hear each message, hear the end. */
type Transport = {
  send(text: string): void;
  onMessage(fn: (text: string) => void): void;
  onClose(fn: () => void): void;
  close(): void;
};

type Pending = { resolve: (msg: CdpMessage) => void; method: string };

function createConnection(transport: Transport): CdpConnection {
  let nextId = 0;
  let isClosed = false;
  const pending = new Map<number, Pending>();
  const eventFns = new Set<(msg: CdpMessage) => void>();
  let markClosed!: () => void;
  const closed = new Promise<void>(resolve => (markClosed = resolve));

  transport.onMessage(text => {
    let msg: CdpMessage;
    try {
      msg = JSON.parse(text) as CdpMessage;
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      entry?.resolve(msg);
    } else if (msg.method) {
      for (const fn of [...eventFns]) fn(msg);
    }
  });
  transport.onClose(() => {
    if (isClosed) return;
    isClosed = true;
    for (const [id, entry] of pending) entry.resolve({ id, error: { message: 'CDP connection closed' } });
    pending.clear();
    eventFns.clear();
    markClosed();
  });

  const request = (method: string, params: unknown, sessionId: string | undefined, resolve: (msg: CdpMessage) => void): void => {
    if (isClosed) return resolve({ error: { message: 'CDP connection closed' } });
    const id = ++nextId;
    pending.set(id, { resolve, method });
    try {
      transport.send(JSON.stringify({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) }));
    } catch (error) {
      pending.delete(id);
      resolve({ id, error: { message: error instanceof Error ? error.message : String(error) } });
    }
  };
  const call = (method: string, params: unknown, sessionId: string | undefined): Promise<CdpMessage> =>
    new Promise(resolve => request(method, params, sessionId, resolve));

  const onEvent = (fn: (msg: CdpMessage) => void) => {
    eventFns.add(fn);
    return () => void eventFns.delete(fn);
  };

  const close = () => transport.close();

  return {
    call,
    request,
    onEvent,
    close,
    closed,
    session: sessionId => {
      // A named session's close detaches that session alone: the host streams from several pages
      // on one pipe (hearsay-tools/cezarion#784). The root session's close ends the connection.
      const offs = new Set<() => void>();
      let detached = false;
      return {
        send: async <T>(method: string, params: Record<string, unknown> = {}) => {
          if (detached) throw new Error(`${method}: CDP session detached`);
          const reply = await call(method, params, sessionId);
          if (reply.error) throw new Error(`${method}: ${reply.error.message ?? 'CDP error'}`);
          return reply.result as T;
        },
        on: <T>(event: string, fn: (params: T) => void) => {
          const off = onEvent(msg => {
            if (msg.method === event && msg.sessionId === sessionId) fn(msg.params as T);
          });
          offs.add(off);
          return () => { off(); offs.delete(off); };
        },
        close: () => {
          if (sessionId === undefined) return close();
          if (detached) return;
          detached = true;
          for (const off of offs) off();
          offs.clear();
          request('Target.detachFromTarget', { sessionId }, undefined, () => {});
        },
        closed,
      };
    },
  };
}

/** One page target's WebSocket. The tests' fake CDP servers speak it. */
export function connectCdp(wsUrl: string): Promise<Cdp> {
  return new Promise((resolveConnect, rejectConnect) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    const connection = createConnection({
      send: text => {
        if (ws.readyState !== WebSocket.OPEN) throw new Error('CDP connection closed');
        ws.send(text);
      },
      onMessage: fn => ws.on('message', raw => fn(String(raw))),
      onClose: fn => ws.once('close', fn),
      close: () => ws.close(),
    });
    ws.once('open', () => resolveConnect(connection.session(undefined)));
    // Before `open` an error is the connect failure; afterwards `close` follows and does the cleanup.
    ws.once('error', err => rejectConnect(err));
    ws.on('error', () => {});
  });
}

/**
 * Chromium's `--remote-debugging-pipe` (hearsay-tools/cezarion#784): commands go into fd 3 and
 * replies come out of fd 4, each message ended by a NUL byte. No port exists, so only this process
 * reaches the browser.
 */
export function cdpOverPipe(toBrowser: Writable, fromBrowser: Readable): CdpConnection {
  let ended = false;
  const closeFns: Array<() => void> = [];
  const end = () => {
    if (ended) return;
    ended = true;
    for (const fn of closeFns) fn();
  };
  let buffered = '';
  const messageFns: Array<(text: string) => void> = [];
  fromBrowser.setEncoding('utf8');
  fromBrowser.on('data', (chunk: string) => {
    buffered += chunk;
    for (let at = buffered.indexOf('\0'); at >= 0; at = buffered.indexOf('\0')) {
      const text = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      for (const fn of messageFns) fn(text);
    }
  });
  // A browser that exits resets the pipe; that is an ordinary end, never an uncaught error.
  fromBrowser.on('error', end);
  toBrowser.on('error', end);
  fromBrowser.once('close', end);
  fromBrowser.once('end', end);
  return createConnection({
    send: text => {
      if (ended) throw new Error('CDP connection closed');
      toBrowser.write(`${text}\0`);
    },
    onMessage: fn => messageFns.push(fn),
    onClose: fn => (ended ? queueMicrotask(fn) : closeFns.push(fn)),
    close: () => {
      toBrowser.end();
      fromBrowser.destroy();
      end();
    },
  });
}
