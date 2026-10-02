import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { connectCdp } from './cdp.ts';

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
    await new Promise(resolve => setTimeout(resolve, 50));
    off();
    serverSock.send(JSON.stringify({ method: 'Page.frameNavigated', params: { n: 2 } }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(first).toEqual([{ n: 1 }]);
    expect(second).toEqual([{ n: 1 }, { n: 2 }]);
    expect(other).toEqual([]);
    cdp.close();
  });

  it('settles `closed` and rejects in-flight and later sends when the socket closes', async () => {
    let serverSock!: WebSocket;
    const url = await startServer(sock => {
      serverSock = sock;
    });
    const cdp = await connectCdp(url);
    const inFlight = cdp.send('Page.enable');
    await new Promise(resolve => setTimeout(resolve, 20));
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
