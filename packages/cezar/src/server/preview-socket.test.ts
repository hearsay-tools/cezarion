import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PreviewClientMessage } from '@open-mercato/cezar-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { PreviewHost, RunContext } from '../preview/host.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import type { Viewer } from '../preview/session.ts';
import { createPreviewSocket, type PreviewSocket, type PreviewSocketHost } from './preview-socket.ts';
import { startServer, verifyWsUpgrade } from './server.ts';
import { attachUpgradeRouter } from './upgrade-router.ts';

/**
 * The preview WebSocket (#781, spec 2026-10-02-live-preview-v1 "WebSocket") over a real
 * `http.Server` and the real upgrade guard: every refusal happens before the handshake, and once
 * connected a malformed frame is dropped without costing the pane its socket.
 */

const servers: Server[] = [];
const sockets: PreviewSocket[] = [];
let worktree: string;

beforeEach(() => {
  vi.stubEnv('CEZ_PREVIEW', '1');
  vi.stubEnv('CEZ_REMOTE', '');
  worktree = mkdtempSync(join(tmpdir(), 'cez-preview-ws-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  rmSync(worktree, { recursive: true, force: true });
});

type Call = { kind: 'handle'; ctx: RunContext; msg: PreviewClientMessage } | { kind: 'detach'; runId: string };

function fakeHost() {
  const calls: Call[] = [];
  const host: PreviewSocketHost = {
    async handle(ctx: RunContext, viewer: Viewer, msg: PreviewClientMessage) {
      calls.push({ kind: 'handle', ctx, msg });
      if (msg.t === 'ping') viewer.send({ t: 'pong', ts: msg.ts });
      if (msg.t === 'open') viewer.sendFrame(Buffer.from([0xff, 0xd8, 0xff]));
    },
    detach(runId: string) {
      calls.push({ kind: 'detach', runId });
    },
  };
  return { host, calls };
}

const runs = () => new Map<string, { id: string; title: string; worktreePath?: string }>([
  ['run-1', { id: 'run-1', title: 'Build the card', worktreePath: worktree }],
  ['gone', { id: 'gone', title: 'Old task', worktreePath: join(worktree, 'removed') }],
]);

async function boot(opts: { host?: PreviewSocketHost; log?: (line: string) => void } = {}) {
  const records = runs();
  const store = { getRun: (id: string) => records.get(id), appendEvent: () => undefined } as unknown as RunContext['store'];
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const socket = createPreviewSocket({
    host: opts.host,
    verify: req => verifyWsUpgrade(req),
    resolveProject: async projectId => (projectId === undefined || projectId === 'proj' ? { store, dataDir: join(worktree, 'data') } : undefined),
    ...(opts.log ? { log: opts.log } : {}),
  });
  attachUpgradeRouter(server, [socket.route]);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  sockets.push(socket);
  const { port } = server.address() as AddressInfo;
  return { port, url: (path: string) => `ws://127.0.0.1:${port}${path}` };
}

/** Resolves with the handshake's outcome: `open` and the socket, or the HTTP status it got. */
function connect(url: string, origin?: string): Promise<{ status: number | 'open'; ws: WebSocket; messages: Array<string | Buffer> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    const messages: Array<string | Buffer> = [];
    ws.on('message', (raw, isBinary) => messages.push(isBinary ? (raw as Buffer) : String(raw)));
    ws.once('open', () => resolve({ status: 'open', ws, messages }));
    ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0, ws, messages }));
    ws.once('error', reject);
  });
}

const SCOPED = '/api/v1/p/proj/runs/run-1/preview/ws';

describe('the preview WebSocket', () => {
  it('answers 404 before the handshake when CEZ_PREVIEW is off', async () => {
    vi.stubEnv('CEZ_PREVIEW', '');
    const { url } = await boot({ host: fakeHost().host });
    expect((await connect(url(SCOPED))).status).toBe(404);
  });

  it('answers 404 when no preview host runs, even with the flag on', async () => {
    const { url } = await boot();
    expect((await connect(url(SCOPED))).status).toBe(404);
  });

  it('refuses an untrusted loopback origin (another port, no Sec-Fetch-Site) with 403', async () => {
    const { url, port } = await boot({ host: fakeHost().host });
    expect((await connect(url(SCOPED), `http://127.0.0.1:${port + 1}`)).status).toBe(403);
  });

  it('accepts the cockpit itself (same-origin) with 101', async () => {
    const { url, port } = await boot({ host: fakeHost().host });
    const { status, ws } = await connect(url(SCOPED), `http://127.0.0.1:${port}`);
    expect(status).toBe('open');
    ws.close();
  });

  it('answers 404 for an unknown project or run', async () => {
    const { url } = await boot({ host: fakeHost().host });
    expect((await connect(url('/api/v1/p/other/runs/run-1/preview/ws'))).status).toBe(404);
    expect((await connect(url('/api/v1/p/proj/runs/nope/preview/ws'))).status).toBe(404);
    expect((await connect(url('/api/v1/p/Bad_Slug!/runs/run-1/preview/ws'))).status).toBe(404);
  });

  it('serves the boot alias', async () => {
    const { host, calls } = fakeHost();
    const { url } = await boot({ host });
    const { status, ws } = await connect(url('/api/v1/runs/run-1/preview/ws'));
    expect(status).toBe('open');
    ws.send(JSON.stringify({ t: 'ping', ts: 1 }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    ws.close();
  });

  it('completes the handshake for a removed worktree and says so', async () => {
    const { host, calls } = fakeHost();
    const { url } = await boot({ host });
    const { status, ws, messages } = await connect(url('/api/v1/p/proj/runs/gone/preview/ws'));
    expect(status).toBe('open');
    await vi.waitFor(() => expect(messages).toEqual([JSON.stringify({ t: 'state', stage: 'worktree-removed' })]));
    ws.send(JSON.stringify({ t: 'open', target: { port: 5173 } }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(calls).toEqual([]);
    ws.close();
  });

  it('drops a malformed frame without closing the socket, logging once per connection', async () => {
    const { host, calls } = fakeHost();
    const log = vi.fn();
    const { url } = await boot({ host, log });
    const { ws, messages } = await connect(url(SCOPED));
    ws.send('not json');
    ws.send(JSON.stringify({ t: 'exec', code: 'rm -rf /' }));
    ws.send(Buffer.from([1, 2, 3]));
    ws.send(JSON.stringify({ t: 'ping', ts: 7 }));
    await vi.waitFor(() => expect(messages).toContain(JSON.stringify({ t: 'pong', ts: 7 })));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(calls).toEqual([expect.objectContaining({ kind: 'handle', msg: { t: 'ping', ts: 7 } })]);
    expect(log).toHaveBeenCalledTimes(1);
    ws.close();
  });

  it('hands the host the run context, sends frames as binary, and detaches on close', async () => {
    const { host, calls } = fakeHost();
    const { url } = await boot({ host });
    const { ws, messages } = await connect(url(SCOPED));
    ws.send(JSON.stringify({ t: 'open', target: { port: 5173 } }));
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(Buffer.isBuffer(messages[0])).toBe(true);
    const first = calls[0];
    expect(first?.kind === 'handle' && first.ctx).toMatchObject({ runId: 'run-1', title: 'Build the card', worktreePath: worktree, dataDir: join(worktree, 'data') });
    ws.close();
    await vi.waitFor(() => expect(calls.at(-1)).toEqual({ kind: 'detach', runId: 'run-1' }));
  });

  it('reaps a viewer that stops answering the protocol ping', async () => {
    const { host, calls } = fakeHost();
    const records = runs();
    const store = { getRun: (id: string) => records.get(id), appendEvent: () => undefined } as unknown as RunContext['store'];
    const server = createServer();
    const socket = createPreviewSocket({ host, verify: () => ({ trusted: true }), resolveProject: async () => ({ store, dataDir: worktree }), heartbeatMs: 40 });
    attachUpgradeRouter(server, [socket.route]);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    sockets.push(socket);
    const { port } = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${SCOPED}`, { autoPong: false });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    await vi.waitFor(() => expect(calls).toContainEqual({ kind: 'detach', runId: 'run-1' }), { timeout: 2_000 });
    ws.terminate();
  });
});

describe('startServer routes both sockets through one upgrade listener', () => {
  it('serves the bus, the scoped preview path and its boot alias, and destroys the rest', async () => {
    const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cez-preview-boot-')));
    const store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const run = store.createRun({ title: 'With a worktree', workflow: 'quick-task', task: 't', steps: [] });
    mkdirSync(join(repoRoot, 'wt'));
    store.updateRun(run.id, { worktreePath: join(repoRoot, 'wt') });
    const { host, calls } = fakeHost();
    const previewHost = { ...host, release: vi.fn(async () => undefined), close: vi.fn(async () => undefined) } as unknown as PreviewHost;
    const server = startServer({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', bootProjectId: 'boot', previewHost }, 0);
    try {
      if (!server.listening) await once(server, 'listening');
      const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const bus = await connect(`${base}/api/v1/ws`);
      expect(bus.status).toBe('open');
      bus.ws.close();
      for (const path of [`/api/v1/p/default/runs/${run.id}/preview/ws`, `/api/v1/p/boot/runs/${run.id}/preview/ws`, `/api/v1/runs/${run.id}/preview/ws`]) {
        const pane = await connect(`${base}${path}`);
        expect(pane.status).toBe('open');
        pane.ws.send(JSON.stringify({ t: 'ping', ts: 1 }));
        await vi.waitFor(() => expect(pane.messages).toContain(JSON.stringify({ t: 'pong', ts: 1 })));
        pane.ws.close();
      }
      expect(calls.filter(call => call.kind === 'handle').map(call => call.kind === 'handle' && call.ctx.worktreePath)).toEqual(Array(3).fill(join(repoRoot, 'wt')));
      expect((await connect(`${base}/api/v1/p/default/runs/nope/preview/ws`)).status).toBe(404);
      await expect(connect(`${base}/api/v1/other`)).rejects.toThrow();
      store.deleteRun(run.id);
      expect(previewHost.release).toHaveBeenCalledWith(run.id, { deleteProfile: true, dataDir: join(repoRoot, '.ai/cezar') });
    } finally {
      await new Promise(done => server.close(done));
      rmSync(repoRoot, { recursive: true, force: true });
    }
    expect(previewHost.close).toHaveBeenCalled();
  });
});
