import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createPreviewCdpSocket } from '../server/preview-cdp-socket.ts';
import { attachUpgradeRouter } from '../server/upgrade-router.ts';
import { previewCdpUrl } from './agent-address.ts';
import { resolveChromium } from './chromium.ts';
import { PreviewHost, type RunContext } from './host.ts';
import { fakeViewer } from './preview.testkit.ts';

/**
 * The agent's path to a real Chromium (hearsay-tools/cezarion#784): the CDP proxy route, the host's
 * grant and the DevTools pipe. A raw CDP client stands in for agent-browser and drives the page the
 * owner's pane streams; the pane sees the navigation. Skipped where no Chromium is installed.
 */

// bound: a cold Chrome start on a loaded CI runner took over 30 s (hearsay-tools/cezarion#1467);
// every wait below still ends on its own event.
const BUDGET_MS = 120_000;
const bin = resolveChromium();

let servers: Server[] = [];
let cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** A CDP client over the agent's socket: commands by id, events by method. */
function agentClient(url: string) {
  const ws = new WebSocket(url);
  let nextId = 0;
  const replies = new Map<number, (msg: { result?: unknown; error?: { message: string } }) => void>();
  const waiters: Array<{ method: string; sessionId: string; resolve(): void }> = [];
  ws.on('message', raw => {
    const msg = JSON.parse(String(raw));
    if (typeof msg.id === 'number') return replies.get(msg.id)?.(msg);
    for (const waiter of waiters.splice(0)) {
      if (waiter.method === msg.method && waiter.sessionId === msg.sessionId) waiter.resolve();
      else waiters.push(waiter);
    }
  });
  /** Settles on the next `method` event on `sessionId`; subscribe before the command that causes it. */
  const next = (method: string, sessionId: string) => new Promise<void>(resolve => waiters.push({ method, sessionId, resolve }));
  const opened = new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  const send = <T>(method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<T>((resolve, reject) => {
      const id = ++nextId;
      replies.set(id, msg => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result as T)));
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { ws, opened, send, next };
}

describe('the agent drives the real preview browser (hearsay-tools/cezarion#784)', () => {
  it.skipIf(process.platform === 'win32' || !bin)('navigates the page the pane streams, and cannot close the browser', async () => {
    vi.stubEnv('CEZ_PREVIEW', '1');
    const dataDir = mkdtempSync(join(tmpdir(), 'cez-agent-cdp-'));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const appPort = await listen(createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>agent app</title><h1>driven by the agent</h1>');
    }));

    const events: Array<Record<string, unknown>> = [];
    const store = { getRun: () => ({ id: 'run-1' }), appendEvent: (_runId: string, event: Record<string, unknown>) => { events.push(event); return event; } };
    const ctx: RunContext = { runId: 'run-1', title: 'Agent drives', worktreePath: dataDir, dataDir, store: store as unknown as RunContext['store'] };
    const host = new PreviewHost({ env: { ...process.env, CEZ_PREVIEW_NO_SANDBOX: '1' } });
    cleanups.push(() => host.close());
    const socket = createPreviewCdpSocket({ host });
    cleanups.push(() => socket.close());
    const cockpit = createServer((_req, res) => res.end());
    attachUpgradeRouter(cockpit, [socket.route]);
    const cockpitPort = await listen(cockpit);

    const grant = host.grantAgent('run-1', () => ctx);
    const agent = agentClient(previewCdpUrl(`http://127.0.0.1:${cockpitPort}`, grant.token)!);
    cleanups.push(() => { agent.ws.terminate(); });
    await agent.opened;

    // What agent-browser does on connect: list the pages, attach to the live one.
    const { targetInfos } = await agent.send<{ targetInfos: Array<{ type: string; targetId: string }> }>('Target.getTargets');
    const pages = targetInfos.filter(target => target.type === 'page');
    expect(pages).toHaveLength(1);
    const { sessionId } = await agent.send<{ sessionId: string }>('Target.attachToTarget', { targetId: pages[0]!.targetId, flatten: true });
    await agent.send('Page.enable', {}, sessionId);
    expect(events).toEqual([{ type: 'preview.agent-browser', state: 'connected' }]);

    // The owner opens the agent's page, and watches the agent navigate it.
    const viewer = fakeViewer();
    await host.handle(ctx, viewer, { t: 'open', target: { agent: true } });
    const loaded = agent.next('Page.loadEventFired', sessionId);
    await agent.send('Page.navigate', { url: `http://localhost:${appPort}/` }, sessionId);
    await loaded;
    await vi.waitFor(() => expect(viewer.messages).toContainEqual({ t: 'url', url: `http://localhost:${appPort}/` }), { timeout: BUDGET_MS, interval: 50 });
    await vi.waitFor(() => expect(viewer.frames.length).toBeGreaterThan(0), { timeout: BUDGET_MS, interval: 50 });
    const { result } = await agent.send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId);
    expect(result.value).toBe('agent app');

    // The owner's browser outlives the agent's attempt to close it.
    await expect(agent.send('Browser.close')).rejects.toThrow(/cezar refuses Browser\.close/);
    expect(host.ownsBrowser('run-1')).toBe(true);

    // The session ends: its socket closes, and the browser is the pane's alone.
    const closed = new Promise<number>(resolve => agent.ws.once('close', code => resolve(code)));
    grant.revoke();
    expect(await closed).toBe(1008);
    expect(events.at(-1)).toEqual({ type: 'preview.agent-browser', state: 'disconnected' });
    expect(host.ownsBrowser('run-1')).toBe(true);
    host.detach('run-1', viewer);
  }, BUDGET_MS * 2);
});
