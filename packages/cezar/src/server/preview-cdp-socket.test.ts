import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { AgentClient } from '../preview/cdp-proxy.ts';
import { createPreviewCdpSocket, type PreviewCdpHost } from './preview-cdp-socket.ts';
import { attachUpgradeRouter } from './upgrade-router.ts';

/** Hang guard for the waits below: each ends on its own event. */
const HANG_GUARD_MS = 15_000;

let server: Server | undefined;
let closeSocket: (() => void) | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  closeSocket?.();
  closeSocket = undefined;
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** A host whose one grant is `good`; a connection echoes each command as a reply and records it. */
function fakeHost(opts: { refuse?: string } = {}) {
  const received: string[] = [];
  const clients: AgentClient[] = [];
  let closes = 0;
  const host: PreviewCdpHost = {
    hasAgentGrant: token => token === 'good',
    connectAgent: async (_token, client) => {
      if (opts.refuse) return { refused: opts.refuse };
      clients.push(client);
      return {
        fromClient: (text: string) => {
          received.push(text);
          const { id } = JSON.parse(text) as { id: number };
          client.send(JSON.stringify({ id, result: {} }));
        },
        close: () => { closes += 1; },
      } as never;
    },
  };
  return { host, received, clients, closes: () => closes };
}

async function listen(host: PreviewCdpHost | undefined, cockpitOrigin?: string): Promise<number> {
  vi.stubEnv('CEZ_PREVIEW', '1');
  const socket = createPreviewCdpSocket({ host, cockpitOrigin: () => cockpitOrigin });
  closeSocket = socket.close;
  server = createServer((_req, res) => res.end());
  attachUpgradeRouter(server, [socket.route]);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** The HTTP status an upgrade attempt is refused with, or 101 once it opened. */
function upgradeStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise(resolve => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => { ws.close(); resolve(101); });
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.once('error', () => undefined);
  });
}

describe('the agent CDP proxy socket (hearsay-tools/cezarion#784)', () => {
  it('refuses an unknown token, any Origin, and a foreign Host before the handshake', async () => {
    const port = await listen(fakeHost().host);
    const base = `ws://127.0.0.1:${port}/api/v1/preview/cdp`;
    expect(await upgradeStatus(`${base}/bad`)).toBe(403);
    expect(await upgradeStatus(`${base}/good`, { origin: 'http://evil.example' })).toBe(403);
    expect(await upgradeStatus(`${base}/good`, { host: 'evil.example' })).toBe(403);
    expect(await upgradeStatus(`${base}/good`)).toBe(101);
  });

  it("accepts the cockpit's own bound host, which the agent's address names", async () => {
    const port = await listen(fakeHost().host, 'http://192.0.2.10:4321');
    expect(await upgradeStatus(`ws://127.0.0.1:${port}/api/v1/preview/cdp/good`, { host: '192.0.2.10:4321' })).toBe(101);
    expect(await upgradeStatus(`ws://127.0.0.1:${port}/api/v1/preview/cdp/good`, { host: '192.0.2.11:4321' })).toBe(403);
  });

  it('answers 404 with the feature off or no host', async () => {
    const port = await listen(undefined);
    expect(await upgradeStatus(`ws://127.0.0.1:${port}/api/v1/preview/cdp/good`)).toBe(404);
    closeSocket?.();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    const second = await listen(fakeHost().host);
    vi.stubEnv('CEZ_PREVIEW', '');
    expect(await upgradeStatus(`ws://127.0.0.1:${second}/api/v1/preview/cdp/good`)).toBe(404);
  });

  it('forwards commands sent before the browser was ready, in order, and replies on the socket', async () => {
    const fake = fakeHost();
    const port = await listen(fake.host);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/preview/cdp/good`);
    const replies: unknown[] = [];
    ws.on('message', raw => replies.push(JSON.parse(String(raw))));
    await new Promise(resolve => ws.once('open', resolve));
    ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
    ws.send(JSON.stringify({ id: 2, method: 'Target.attachToTarget' }));
    await vi.waitFor(() => expect(replies).toEqual([{ id: 1, result: {} }, { id: 2, result: {} }]), { timeout: HANG_GUARD_MS });
    expect(fake.received.map(text => JSON.parse(text).id)).toEqual([1, 2]);
    ws.close();
    await vi.waitFor(() => expect(fake.closes()).toBe(1), { timeout: HANG_GUARD_MS });
  });

  it("closes with 1008 and the host's reason when the host refuses the connection", async () => {
    const port = await listen(fakeHost({ refuse: 'The preview browser failed; the owner can retry it from the preview pane' }).host);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/preview/cdp/good`);
    const [code, reason] = await new Promise<[number, string]>(resolve => ws.once('close', (c, r) => resolve([c, String(r)])));
    expect(code).toBe(1008);
    expect(reason).toBe('The preview browser failed; the owner can retry it from the preview pane');
  });

  it("closes the socket with the link's code when the host closes the agent", async () => {
    const fake = fakeHost();
    const port = await listen(fake.host);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/preview/cdp/good`);
    await new Promise(resolve => ws.once('open', resolve));
    await vi.waitFor(() => expect(fake.clients).toHaveLength(1), { timeout: HANG_GUARD_MS });
    const closed = new Promise<[number, string]>(resolve => ws.once('close', (c, r) => resolve([c, String(r)])));
    fake.clients[0]!.close(1008, "The agent's session ended");
    expect(await closed).toEqual([1008, "The agent's session ended"]);
  });
});
