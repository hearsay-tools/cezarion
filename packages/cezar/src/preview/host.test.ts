import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PreviewServer } from '@open-mercato/cezar-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevServerState, DevServerStopReason } from './dev-server.ts';
import { ChromiumError } from './chromium.ts';
import { ChromiumMissingError, PREVIEW_BROWSER_IDLE_MS, PREVIEW_SERVER_IDLE_MS, PreviewHost, type BrowserHandle, type RunContext } from './host.ts';
import { fakeCdp, fakeViewer } from './preview.testkit.ts';

class FakeDevServer extends EventEmitter {
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

const server = (port: number, extra: Partial<PreviewServer> = {}): PreviewServer => ({
  port, command: 'npm run dev', label: 'web', registeredAt: '2026-10-02T10:00:00.000Z', answeredAtRegistration: false, ...extra,
});

function fakeStore(servers: PreviewServer[]) {
  const events: Array<{ runId: string; event: Record<string, unknown> }> = [];
  const runs = new Map([['run-1', { id: 'run-1', previewServers: servers }]]);
  return {
    events,
    stateEvents: () => events.filter(entry => entry.event.type === 'preview.server-state').map(entry => entry.event),
    getRun: (id: string) => runs.get(id),
    appendEvent: (runId: string, event: Record<string, unknown>) => { events.push({ runId, event }); return event; },
  };
}

function setup(servers: PreviewServer[] = [server(5173)], launchError?: () => Error | undefined) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cez-preview-host-'));
  const store = fakeStore(servers);
  const answering = new Set<number>();
  const devServers: FakeDevServer[] = [];
  const browsers: Array<BrowserHandle & { cdpFake: ReturnType<typeof fakeCdp>; exit(info: { signal?: string; stderrTail: string }): void; profileDir: string }> = [];
  const host = new PreviewHost({
    probe: async port => answering.has(port),
    createServer: opts => {
      const dev = new FakeDevServer(opts);
      devServers.push(dev);
      return dev;
    },
    launchBrowser: async profileDir => {
      const error = launchError?.();
      if (error) throw error;
      const cdpFake = fakeCdp();
      let exit!: (info: { signal?: string; stderrTail: string }) => void;
      const exited = new Promise<{ signal?: string; stderrTail: string }>(resolve => (exit = resolve));
      const handle = { cdp: cdpFake.cdp, exited, close: vi.fn(), cdpFake, exit, profileDir };
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
  });
  const ctx: RunContext = { runId: 'run-1', title: 'Build the app', worktreePath: '/repo/wt', dataDir, store: store as unknown as RunContext['store'] };
  return { host, ctx, store, answering, devServers, browsers, dataDir };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const stages = (viewer: ReturnType<typeof fakeViewer>) =>
  viewer.messages.flatMap(msg => (msg.t === 'state' ? [msg.stage] : []));
const navigations = (browser: { cdpFake: ReturnType<typeof fakeCdp> }) =>
  browser.cdpFake.sent('Page.navigate').map(call => call.params.url);

describe('PreviewHost', () => {
  let dirs: string[] = [];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });
  const make = (servers?: PreviewServer[], launchError?: () => Error | undefined) => {
    const env = setup(servers, launchError);
    dirs.push(env.dataDir);
    return env;
  };

  it('answers open on a silent registered port with needs-approval and spawns nothing', async () => {
    const { host, ctx, devServers, browsers } = make([server(5173, { answeredAtRegistration: true })]);
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    expect(viewer.messages).toEqual([{ t: 'state', stage: 'needs-approval', server: server(5173, { answeredAtRegistration: true }), wasRunning: true }]);
    expect(devServers).toHaveLength(0);
    expect(browsers).toHaveLength(0);
  });

  it('spawns only on run, and streams the server once it is up', async () => {
    const { host, ctx, devServers, browsers, store } = make([server(5173, { path: '/admin' })]);
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    expect(devServers).toHaveLength(0);

    await host.run('run-1', 5173);
    expect(devServers).toHaveLength(1);
    expect(devServers[0]!.started).toBe(true);
    expect(devServers[0]!.opts).toMatchObject({ worktreePath: '/repo/wt', dir: join(ctx.dataDir, 'preview', 'run-1') });
    expect(viewer.messages.at(-1)).toMatchObject({ t: 'state', stage: 'server-starting', attempt: 0 });

    devServers[0]!.attempt();
    expect(viewer.messages.at(-1)).toMatchObject({ t: 'state', stage: 'server-starting', attempt: 1 });

    devServers[0]!.set('up');
    await flush();
    expect(browsers).toHaveLength(1);
    expect(browsers[0]!.profileDir).toBe(join(ctx.dataDir, 'preview', 'run-1', 'profile'));
    expect(navigations(browsers[0]!)).toEqual(['http://localhost:5173/admin']);
    expect(stages(viewer)).toEqual(['needs-approval', 'server-starting', 'server-starting', 'loading', 'loading', 'loading']);

    browsers[0]!.cdpFake.emit('Page.screencastFrame', { data: Buffer.from('jpeg').toString('base64'), sessionId: 1 });
    expect(viewer.messages.at(-1)).toEqual({ t: 'state', stage: 'streaming', adopted: false });
    expect(viewer.frames).toEqual(['jpeg']);
    expect(store.stateEvents()).toEqual([
      { type: 'preview.server-state', port: 5173, state: 'starting' },
      { type: 'preview.server-state', port: 5173, state: 'up' },
    ]);
  });

  it('adopts an answering port at open, streams it, and refuses to stop it', async () => {
    const { host, ctx, answering, devServers, browsers } = make();
    answering.add(5173);
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    expect(devServers).toHaveLength(0);
    expect(navigations(browsers[0]!)).toEqual(['http://localhost:5173/']);
    browsers[0]!.cdpFake.emit('Page.screencastFrame', { data: 'AA==', sessionId: 1 });
    expect(viewer.messages.at(-1)).toEqual({ t: 'state', stage: 'streaming', adopted: true });

    expect(await host.stop('run-1', 5173, 'user')).toBe(false);
    expect(host.portOwner(5173)).toBeUndefined();
  });

  it('a second viewer replaces the first', async () => {
    const { host, ctx, answering, browsers } = make();
    answering.add(5173);
    const first = fakeViewer('Firefox');
    const second = fakeViewer('Safari on iPhone');
    await host.open(ctx, first, { port: 5173 });
    await host.open(ctx, second, { port: 5173 });
    expect(first.messages.at(-1)).toEqual({ t: 'replaced', by: 'Safari on iPhone' });
    expect(first.closed).toHaveLength(1);
    expect(browsers).toHaveLength(1);

    browsers[0]!.cdpFake.emit('Page.screencastFrame', { data: 'AA==', sessionId: 1 });
    expect(second.frames).toHaveLength(1);
    expect(first.frames).toHaveLength(0);
    // The replaced viewer's input no longer reaches the page.
    await host.handle(ctx, first, { t: 'reload' });
    expect(browsers[0]!.cdpFake.sent('Page.reload')).toHaveLength(0);
  });

  it('stops cezar-owned servers 15 min after the last viewer leaves and keeps adopted ones', async () => {
    const { host, ctx, answering, devServers, browsers, store } = make([server(5173), server(3000)]);
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run('run-1', 5173);
    devServers[0]!.set('up');
    answering.add(3000);
    await host.open(ctx, viewer, { port: 3000 });
    host.detach('run-1', viewer);

    await vi.advanceTimersByTimeAsync(PREVIEW_BROWSER_IDLE_MS);
    expect(browsers[0]!.close).toHaveBeenCalled();
    expect(devServers[0]!.stop).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PREVIEW_SERVER_IDLE_MS - PREVIEW_BROWSER_IDLE_MS);
    expect(devServers[0]!.stop).toHaveBeenCalledWith('idle');
    expect(devServers).toHaveLength(1);
    expect(store.stateEvents().at(-1)).toEqual({ type: 'preview.server-state', port: 5173, state: 'stopped', reason: 'idle' });
    // The adopted server is not cezar's to stop: it is still served on the next open.
    const back = fakeViewer();
    await host.open(ctx, back, { port: 3000 });
    expect(stages(back)).not.toContain('needs-approval');
  });

  it('a viewer that comes back before the idle window cancels both timers', async () => {
    const { host, ctx, devServers, browsers } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run('run-1', 5173);
    devServers[0]!.set('up');
    await flush();
    host.detach('run-1', viewer);
    await vi.advanceTimersByTimeAsync(PREVIEW_BROWSER_IDLE_MS - 1);
    await host.open(ctx, fakeViewer(), { port: 5173 });
    await vi.advanceTimersByTimeAsync(PREVIEW_SERVER_IDLE_MS);
    expect(browsers[0]!.close).not.toHaveBeenCalled();
    expect(devServers[0]!.stop).not.toHaveBeenCalled();
  });

  it('release stops the servers and closes the session', async () => {
    const { host, ctx, devServers, browsers } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run('run-1', 5173);
    devServers[0]!.set('up');
    await flush();
    expect(host.portOwner(5173)).toEqual({ runId: 'run-1', title: 'Build the app' });

    await host.release('run-1');
    expect(devServers[0]!.stop).toHaveBeenCalledWith('release');
    expect(browsers[0]!.close).toHaveBeenCalled();
    expect(host.portOwner(5173)).toBeUndefined();
    expect(viewer.messages.at(-1)).toEqual({ t: 'state', stage: 'worktree-removed' });
  });

  it('a Chromium exit reports browser-exited and relaunches only on retryBrowser, at the last URL', async () => {
    const { host, ctx, devServers, browsers } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run('run-1', 5173);
    devServers[0]!.set('up');
    await flush();
    browsers[0]!.cdpFake.emit('Page.frameNavigated', { frame: { id: 'main', url: 'http://localhost:5173/settings' } });

    browsers[0]!.exit({ signal: 'SIGSEGV', stderrTail: 'Aw, snap' });
    await flush();
    expect(viewer.messages.at(-1)).toEqual({ t: 'state', stage: 'browser-exited', signal: 'SIGSEGV', stderrTail: 'Aw, snap', serverUp: true });

    // Neither a server transition nor a new open brings Chromium back.
    devServers[0]!.set('stalled');
    devServers[0]!.set('up');
    await host.open(ctx, viewer, { port: 5173 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(browsers).toHaveLength(1);

    await host.handle(ctx, viewer, { t: 'retryBrowser' });
    expect(browsers).toHaveLength(2);
    expect(navigations(browsers[1]!)).toEqual(['http://localhost:5173/settings']);
  });

  it('release with deleteProfile removes the run\'s whole preview directory; a plain release keeps it', async () => {
    const { host, ctx, dataDir } = make();
    const runDir = join(dataDir, 'preview', 'run-1');
    mkdirSync(join(runDir, 'profile'), { recursive: true });
    writeFileSync(join(runDir, 'profile', 'Cookies'), 'session=1');
    await host.open(ctx, fakeViewer(), { port: 5173 });

    await host.release('run-1');
    expect(existsSync(join(runDir, 'profile', 'Cookies'))).toBe(true);

    await host.release('run-1', { deleteProfile: true, dataDir });
    expect(existsSync(runDir)).toBe(false);
  });

  it('appends one preview.server-state per transition and none per probe attempt', async () => {
    const { host, ctx, devServers, store } = make();
    await host.open(ctx, fakeViewer(), { port: 5173 });
    await host.run('run-1', 5173);
    const dev = devServers[0]!;
    for (let i = 0; i < 5; i++) dev.attempt();
    dev.set('stalled');
    host.keepWaiting('run-1', 5173);
    dev.attempt();
    dev.exitCode = 1;
    dev.set('exited');
    expect(store.stateEvents()).toEqual([
      { type: 'preview.server-state', port: 5173, state: 'starting' },
      { type: 'preview.server-state', port: 5173, state: 'stalled' },
      { type: 'preview.server-state', port: 5173, state: 'starting' },
      { type: 'preview.server-state', port: 5173, state: 'exited', exitCode: 1 },
    ]);
  });

  it('forwards server transitions to the viewer looking at that server', async () => {
    const { host, ctx, devServers } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run('run-1', 5173);
    devServers[0]!.set('stalled');
    expect(viewer.messages.at(-1)).toEqual({ t: 'state', stage: 'server-stalled', server: server(5173), logTail: 'ready in 300 ms' });
    devServers[0]!.exitCode = 2;
    devServers[0]!.set('exited');
    expect(viewer.messages.at(-1)).toEqual({ t: 'state', stage: 'server-exited', server: server(5173), exitCode: 2, logTail: 'ready in 300 ms' });
  });

  it('a user stop on a cezar-owned server reports server-stopped with the last URL', async () => {
    const { host, ctx, devServers, store } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run('run-1', 5173);
    devServers[0]!.set('up');
    await flush();
    expect(await host.stop('run-1', 5173, 'user')).toBe(true);
    expect(viewer.messages.at(-1)).toEqual({ t: 'state', stage: 'server-stopped', server: server(5173), reason: 'user', lastUrl: 'http://localhost:5173/' });
    expect(store.stateEvents().at(-1)).toEqual({ type: 'preview.server-state', port: 5173, state: 'stopped', reason: 'user' });
  });

  it('close releases every run', async () => {
    const { host, ctx, devServers } = make();
    await host.open(ctx, fakeViewer(), { port: 5173 });
    await host.run('run-1', 5173);
    await host.close();
    expect(devServers[0]!.stop).toHaveBeenCalledWith('release');
  });

  it('reports a missing Chromium with the OS command, and opens the page once a download lands', async () => {
    let installed = false;
    const { host, ctx, answering, browsers } = make(undefined, () => (installed ? undefined : new ChromiumMissingError('none')));
    answering.add(5173);
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    // linux-arm64 has no Chrome for Testing build: only the OS command.
    expect(viewer.messages.at(-1)).toEqual({ t: 'state', stage: 'chromium-missing', installCommand: 'sudo apt-get install -y chromium', canDownload: false });

    installed = true;
    await host.handle(ctx, viewer, { t: 'download' });
    expect(viewer.messages).toContainEqual({ t: 'downloadProgress', received: 10, total: 10 });
    expect(navigations(browsers[0]!)).toEqual(['http://localhost:5173/']);
  });

  it('a sandbox failure stays on screen until retryBrowser', async () => {
    let failing = true;
    const { host, ctx, answering, browsers } = make(undefined, () => (failing ? new ChromiumError('sandbox', 'No usable sandbox!', 'exited') : undefined));
    answering.add(5173);
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    expect(viewer.messages.at(-1)).toEqual({ t: 'state', stage: 'sandbox-failed', stderrTail: 'No usable sandbox!' });
    failing = false;
    await host.open(ctx, viewer, { port: 5173 });
    expect(browsers).toHaveLength(0);
    await host.handle(ctx, viewer, { t: 'retryBrowser' });
    expect(navigations(browsers[0]!)).toEqual(['http://localhost:5173/']);
  });
});
