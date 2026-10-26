import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { cdpOverPipe, connectCdp } from './cdp.ts';

/** Hang guard for the waits below: each ends the moment its condition holds, so the bound only ends a hang. */
const HANG_GUARD_MS = 15_000;

let server: WebSocketServer | undefined;

async function startServer(onConnection: (sock: WebSocket) => void): Promise<string> {
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', onConnection);
  await new Promise(resolve => server!.once('listening', resolve));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const client of server?.clients ?? []) client.terminate();
  await new Promise(resolve => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

describe('connectCdp (#781)', () => {
  it('correlates responses to requests by id, even out of order', async () => {
    const url = await startServer(sock => {
      const held: { id: number; method: string }[] = [];
      sock.on('message', raw => {
        const msg = JSON.parse(String(raw));
        held.push(msg);
        // Answer the second request first.
        if (held.length === 2) for (const m of [held[1]!, held[0]!]) sock.send(JSON.stringify({ id: m.id, result: { echo: m.method } }));
      });
    });
    const cdp = await connectCdp(url);
    const [a, b] = await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable', { x: 1 })]);
    expect(a).toEqual({ echo: 'Page.enable' });
    expect(b).toEqual({ echo: 'Runtime.enable' });
    cdp.close();
  });

  it('sends params as given and defaults them to an empty object', async () => {
    const seen: unknown[] = [];
    const url = await startServer(sock =>
      sock.on('message', raw => {
        const msg = JSON.parse(String(raw));
        seen.push(msg);
        sock.send(JSON.stringify({ id: msg.id, result: {} }));
      }),
    );
    const cdp = await connectCdp(url);
    await cdp.send('Page.reload');
    await cdp.send('Page.navigate', { url: 'http://localhost:1' });
    expect(seen).toEqual([
      { id: expect.any(Number), method: 'Page.reload', params: {} },
      { id: expect.any(Number), method: 'Page.navigate', params: { url: 'http://localhost:1' } },
    ]);
    cdp.close();
  });

  it('rejects an error response with the method name in the message', async () => {
    const url = await startServer(sock =>
      sock.on('message', raw => {
        const msg = JSON.parse(String(raw));
        sock.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: 'Cannot navigate' } }));
      }),
    );
    const cdp = await connectCdp(url);
    await expect(cdp.send('Page.navigate', { url: 'x' })).rejects.toThrow('Page.navigate: Cannot navigate');
    cdp.close();
  });

  it('dispatches events to every listener of that event, and off() unsubscribes', async () => {
    let serverSock!: WebSocket;
    const url = await startServer(sock => {
      serverSock = sock;
    });
    const cdp = await connectCdp(url);
    const first: unknown[] = [];
    const second: unknown[] = [];
    const other: unknown[] = [];
    const off = cdp.on('Page.frameNavigated', params => first.push(params));
    cdp.on('Page.frameNavigated', params => second.push(params));
    cdp.on('Page.loadEventFired', params => other.push(params));
    serverSock.send(JSON.stringify({ method: 'Page.frameNavigated', params: { n: 1 } }));
    // `second` is registered after `first`, so once it has the event `first` has had it too.
    await vi.waitFor(() => expect(second).toEqual([{ n: 1 }]), { timeout: HANG_GUARD_MS });
    off();
    serverSock.send(JSON.stringify({ method: 'Page.frameNavigated', params: { n: 2 } }));
    await vi.waitFor(() => expect(second).toEqual([{ n: 1 }, { n: 2 }]), { timeout: HANG_GUARD_MS });
    expect(first).toEqual([{ n: 1 }]);
    expect(second).toEqual([{ n: 1 }, { n: 2 }]);
    expect(other).toEqual([]);
    cdp.close();
  });

  it('settles `closed` and rejects in-flight and later sends when the socket closes', async () => {
    let serverSock!: WebSocket;
    let requestArrived!: () => void;
    const arrived = new Promise<void>(resolve => { requestArrived = resolve; });
    const url = await startServer(sock => {
      serverSock = sock;
      sock.on('message', () => requestArrived());
    });
    const cdp = await connectCdp(url);
    const inFlight = cdp.send('Page.enable');
    await arrived; // the server never answers it, so it is in flight when the socket closes
    serverSock.close();
    await expect(inFlight).rejects.toThrow(/closed/i);
    await cdp.closed;
    await expect(cdp.send('Page.enable')).rejects.toThrow(/closed/i);
  });

  it('close() settles `closed`', async () => {
    const url = await startServer(() => {});
    const cdp = await connectCdp(url);
    cdp.close();
    await cdp.closed;
  });

  it('rejects when nothing listens at the URL', async () => {
    await expect(connectCdp('ws://127.0.0.1:1')).rejects.toThrow();
  });
});

describe('cdpOverPipe (hearsay-tools/cezarion#784)', () => {
  /** A fake browser end: what cezar writes arrives on `commands`; `reply` writes NUL-ended frames back. */
  function fakePipe() {
    const toBrowser = new PassThrough();
    const fromBrowser = new PassThrough();
    const commands: Array<Record<string, unknown>> = [];
    let pending = '';
    toBrowser.setEncoding('utf8');
    toBrowser.on('data', (chunk: string) => {
      pending += chunk;
      for (let at = pending.indexOf('\0'); at >= 0; at = pending.indexOf('\0')) {
        commands.push(JSON.parse(pending.slice(0, at)));
        pending = pending.slice(at + 1);
      }
    });
    return { connection: cdpOverPipe(toBrowser, fromBrowser), commands, write: (text: string) => fromBrowser.write(text), end: () => fromBrowser.end() };
  }

  it('ends every command with a NUL byte and names its session only when it has one', async () => {
    const pipe = fakePipe();
    // Never answered: closing the pipe below fails them, which is not what this case checks.
    pipe.connection.session(undefined).send('Browser.getVersion').catch(() => {});
    pipe.connection.session('S1').send('Page.enable', { a: 1 }).catch(() => {});
    await vi.waitFor(() => expect(pipe.commands).toHaveLength(2), { timeout: HANG_GUARD_MS });
    expect(pipe.commands).toEqual([
      { id: 1, method: 'Browser.getVersion', params: {} },
      { id: 2, method: 'Page.enable', params: { a: 1 }, sessionId: 'S1' },
    ]);
    pipe.connection.close();
  });

  it('reassembles replies split across chunks and several replies in one chunk', async () => {
    const pipe = fakePipe();
    const a = pipe.connection.session(undefined).send('A');
    const b = pipe.connection.session(undefined).send('B');
    const c = pipe.connection.session(undefined).send('C');
    pipe.write('{"id":1,"res');
    pipe.write('ult":{"n":1}}\0{"id":2,"result":{"n":2}}\0{"id":3,');
    pipe.write('"result":{"n":3}}\0');
    expect(await Promise.all([a, b, c])).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    pipe.connection.close();
  });

  it('gives each session only its own events, and onEvent every event as it came', async () => {
    const pipe = fakePipe();
    const page: unknown[] = [];
    const root: unknown[] = [];
    const raw: unknown[] = [];
    pipe.connection.session('S1').on('Page.frameNavigated', params => page.push(params));
    pipe.connection.session(undefined).on('Page.frameNavigated', params => root.push(params));
    pipe.connection.onEvent(msg => raw.push(msg));
    pipe.write('{"method":"Page.frameNavigated","params":{"n":1},"sessionId":"S2"}\0');
    pipe.write('{"method":"Page.frameNavigated","params":{"n":2},"sessionId":"S1"}\0');
    pipe.write('{"method":"Page.frameNavigated","params":{"n":3}}\0');
    await vi.waitFor(() => expect(raw).toHaveLength(3), { timeout: HANG_GUARD_MS });
    expect(page).toEqual([{ n: 2 }]);
    expect(root).toEqual([{ n: 3 }]);
    expect(raw[0]).toEqual({ method: 'Page.frameNavigated', params: { n: 1 }, sessionId: 'S2' });
    pipe.connection.close();
  });

  it('hands call() the raw reply, error included, where a session client rejects', async () => {
    const pipe = fakePipe();
    const raw = pipe.connection.call('Browser.close', {}, 'S9');
    const thrown = pipe.connection.session('S9').send('Browser.close');
    const error = { code: -32000, message: 'Not allowed' };
    pipe.write(`{"id":1,"error":${JSON.stringify(error)},"sessionId":"S9"}\0{"id":2,"error":${JSON.stringify(error)},"sessionId":"S9"}\0`);
    expect(await raw).toEqual({ id: 1, error, sessionId: 'S9' });
    await expect(thrown).rejects.toThrow('Browser.close: Not allowed');
    pipe.connection.close();
  });

  it('settles `closed` and fails in-flight and later commands when the browser ends the pipe', async () => {
    const pipe = fakePipe();
    const inFlight = pipe.connection.session(undefined).send('Page.enable');
    await vi.waitFor(() => expect(pipe.commands).toHaveLength(1), { timeout: HANG_GUARD_MS });
    pipe.end();
    await expect(inFlight).rejects.toThrow(/closed/i);
    await pipe.connection.closed;
    expect(await pipe.connection.call('Page.enable', {}, undefined)).toMatchObject({ error: { message: 'CDP connection closed' } });
  });
});
