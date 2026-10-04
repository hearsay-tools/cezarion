import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { attachUpgradeRouter, matchPath, type UpgradeRoute } from './upgrade-router.ts';
import { createSocketHub, socketHubRoute, WS_PATH, type SocketHub } from './ws.ts';

/**
 * The one `upgrade` listener (#781, spec 2026-10-02-live-preview-v1 "WebSocket"), over a real
 * `http.Server`: the bus path still reaches the hub, the preview path reaches its handler with
 * its params, and every other path is destroyed rather than leaked.
 */

const servers: Server[] = [];
const hubs: SocketHub[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) hub.close();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

const PREVIEW_PATTERNS = ['/api/v1/p/:projectId/runs/:id/preview/ws', '/api/v1/runs/:id/preview/ws'];

async function boot() {
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const hub = createSocketHub();
  hub.registerTopic('ticker', { snapshot: async () => ({ tick: 1 }), start: () => () => undefined });
  const seen: Array<Record<string, string>> = [];
  const echo = new WebSocketServer({ noServer: true });
  const preview: UpgradeRoute = {
    match: matchPath(PREVIEW_PATTERNS),
    handle(req, socket, head, params) {
      seen.push(params);
      echo.handleUpgrade(req, socket, head, ws => ws.send(JSON.stringify(params)));
    },
  };
  attachUpgradeRouter(server, [socketHubRoute(hub, () => ({ trusted: true })), preview]);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  hubs.push(hub);
  const { port } = server.address() as AddressInfo;
  return { base: `ws://127.0.0.1:${port}`, seen };
}

function firstMessage(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('message', raw => {
      resolve(JSON.parse(String(raw)));
      ws.close();
    });
    ws.once('error', reject);
  });
}

/** How the client sees a refused upgrade: the socket closes with no handshake. */
function refusal(url: string): Promise<string> {
  return new Promise(resolve => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve('open'));
    ws.once('unexpected-response', (_req, res) => resolve(`status ${res.statusCode}`));
    ws.once('error', error => resolve(`error ${error.message}`));
  });
}

describe('attachUpgradeRouter', () => {
  it('routes the bus path to the hub unchanged', async () => {
    const { base } = await boot();
    const ws = new WebSocket(`${base}${WS_PATH}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'subscribe', topic: 'ticker' }));
    const frame = await new Promise<unknown>(resolve => ws.once('message', raw => resolve(JSON.parse(String(raw)))));
    expect(frame).toEqual({ type: 'event', topic: 'ticker', data: { tick: 1 } });
    ws.close();
  });

  it('routes the scoped preview path to its handler with the decoded params', async () => {
    const { base, seen } = await boot();
    expect(await firstMessage(`${base}/api/v1/p/my-proj/runs/run%201/preview/ws`)).toEqual({ projectId: 'my-proj', id: 'run 1' });
    expect(seen).toEqual([{ projectId: 'my-proj', id: 'run 1' }]);
  });

  it('routes the boot alias without a project id', async () => {
    const { base } = await boot();
    expect(await firstMessage(`${base}/api/v1/runs/abc/preview/ws?x=1`)).toEqual({ id: 'abc' });
  });

  it('destroys any other path', async () => {
    const { base, seen } = await boot();
    expect(await refusal(`${base}/api/v1/other`)).toMatch(/^error /);
    expect(await refusal(`${base}/api/v1/runs/abc/preview/ws/extra`)).toMatch(/^error /);
    expect(seen).toEqual([]);
  });
});

describe('matchPath', () => {
  const match = matchPath(PREVIEW_PATTERNS);

  it('matches either spelling and nothing else', () => {
    expect(match('/api/v1/p/a/runs/b/preview/ws')).toEqual({ projectId: 'a', id: 'b' });
    expect(match('/api/v1/runs/b/preview/ws')).toEqual({ id: 'b' });
    expect(match('/api/v1/p//runs/b/preview/ws')).toBeUndefined();
    expect(match('/api/v1/ws')).toBeUndefined();
  });

  it('refuses a param that does not decode', () => {
    expect(match('/api/v1/runs/%E0%A4%A/preview/ws')).toBeUndefined();
  });
});
