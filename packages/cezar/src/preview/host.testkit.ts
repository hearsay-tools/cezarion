import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PreviewServer } from '@open-mercato/cezar-contract';
import { vi } from 'vitest';
import type { DevServerState, DevServerStopReason } from './dev-server.ts';
import { PreviewHost, type BrowserExit, type BrowserHandle, type PreviewHostDeps, type RunContext } from './host.ts';
import { fakeCdp, fakeConnection, fakeViewer } from './preview.testkit.ts';

export class FakeDevServer extends EventEmitter {
  state: DevServerState = 'starting';
  attempts = 0;
  exitCode?: number;
  stopReason?: DevServerStopReason;
  started = false;
  constructor(readonly opts: { server: PreviewServer; worktreePath: string; dir: string }) { super(); }
  start() { this.started = true; }
  keepWaiting() { if (this.state === 'stalled') this.set('starting'); }
  stop = vi.fn(async (reason: DevServerStopReason) => {
    if (this.state === 'exited' || this.state === 'stopped') return;
    this.stopReason = reason;
    this.set('stopped');
  });
  logTail() { return ['ready in 300 ms']; }
  attempt() { this.attempts += 1; this.emit('attempt', this.attempts); }
  set(state: DevServerState) { this.state = state; this.emit('state', state); }
}

export const server = (port: number, extra: Partial<PreviewServer> = {}): PreviewServer => ({
  port, command: 'npm run dev', label: 'web', registeredAt: '2026-10-02T10:00:00.000Z', answeredAtRegistration: false, ...extra,
});

export function fakeStore(servers: PreviewServer[]) {
  const events: Array<{ runId: string; event: Record<string, unknown> }> = [];
  // run-2 is a second task that registered the same servers (both registered while the ports were silent).
  const runs = new Map([['run-1', { id: 'run-1', previewServers: servers }], ['run-2', { id: 'run-2', previewServers: servers }]]);
  return {
    events,
    stateEvents: () => events.filter(entry => entry.event.type === 'preview.server-state').map(entry => entry.event),
    getRun: (id: string) => runs.get(id),
    appendEvent: (runId: string, event: Record<string, unknown>) => { events.push({ runId, event }); return event; },
  };
}

export function setup(servers: PreviewServer[] = [server(5173)], launchError?: () => Error | undefined, launchGate?: () => Promise<void>, overrides: PreviewHostDeps = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cez-preview-host-'));
  const store = fakeStore(servers);
  const answering = new Set<number>();
  const devServers: FakeDevServer[] = [];
  const probe = vi.fn(async (port: number) => answering.has(port));
  const browsers: Array<BrowserHandle & { cdpFake: ReturnType<typeof fakeCdp>; connectionFake: ReturnType<typeof fakeConnection>; exit(info: BrowserExit): void; profileDir: string }> = [];
  const host = new PreviewHost({
    probe,
    createServer: opts => {
      const dev = new FakeDevServer(opts);
      devServers.push(dev);
      return dev;
    },
    launchBrowser: async profileDir => {
      await launchGate?.();
      const error = launchError?.();
      if (error) throw error;
      const cdpFake = fakeCdp();
      let exit!: (info: BrowserExit) => void;
      const exited = new Promise<BrowserExit>(resolve => (exit = resolve));
      const connectionFake = fakeConnection();
      const handle = { cdp: cdpFake.cdp, connection: connectionFake.connection, pageTargetId: 'PANE', exited, close: vi.fn(), cdpFake, connectionFake, exit, profileDir };
      browsers.push(handle);
      return handle;
    },
    download: async ({ onProgress }) => {
      onProgress(10, 10);
      return '/cache/chrome-headless-shell';
    },
    platform: 'linux',
    arch: 'arm64',
    osRelease: () => 'ID=ubuntu\n',
    ...overrides,
  });
  const ctx: RunContext = { runId: 'run-1', title: 'Build the app', worktreePath: '/repo/wt', dataDir, store: store as unknown as RunContext['store'] };
  return { host, ctx, store, answering, devServers, browsers, dataDir, probe };
}

export const flush = () => vi.advanceTimersByTimeAsync(0);
export const stages = (viewer: ReturnType<typeof fakeViewer>) =>
  viewer.messages.flatMap(msg => (msg.t === 'state' ? [msg.stage] : []));
export const navigations = (browser: { cdpFake: ReturnType<typeof fakeCdp> }) =>
  browser.cdpFake.sent('Page.navigate').map(call => call.params.url);

