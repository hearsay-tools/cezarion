import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PreviewServer } from '@open-mercato/cezar-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChromiumError, installCommand } from './chromium.ts';
import { ChromiumMissingError, PREVIEW_BROWSER_IDLE_MS, PREVIEW_SERVER_IDLE_MS, PreviewHost, type BrowserExit, type PreviewHostDeps, type RunContext } from './host.ts';
import { fakeAgentClient, fakeCdp, fakeConnection, fakeViewer } from './preview.testkit.ts';
import type { CdpConnection } from './cdp.ts';
import { fakeStore, flush, navigations, server, setup, stages } from './host.testkit.ts';

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
  const make = (servers?: PreviewServer[], launchError?: () => Error | undefined, launchGate?: () => Promise<void>, overrides?: PreviewHostDeps) => {
    const env = setup(servers, launchError, launchGate, overrides);
    dirs.push(env.dataDir);
    return env;
  };

  it('a hidden viewer resuming cannot reclaim a preview another tab explicitly opened', async () => {
    const { host, ctx } = make();
    const a = fakeViewer(), b = fakeViewer(), restored = fakeViewer();
    await host.handle(ctx, a, { t: 'open', target: { port: 5173 }, viewerId: 'a' });
    host.detach(ctx.runId, a);
    await host.handle(ctx, b, { t: 'open', target: { port: 5173 }, viewerId: 'b' });
    await host.handle(ctx, restored, { t: 'open', target: { port: 5173 }, viewerId: 'a', resume: true });
    expect(restored.messages.at(-1)).toMatchObject({ t: 'replaced' });
    expect(b.messages.some(message => message.t === 'replaced')).toBe(false);
    host.detach(ctx.runId, b);
    const again = fakeViewer();
    await host.handle(ctx, again, { t: 'open', target: { port: 5173 }, viewerId: 'a', resume: true });
    expect(again.messages.at(-1)).toMatchObject({ t: 'replaced' });
    const explicit = fakeViewer();
    await host.handle(ctx, explicit, { t: 'open', target: { port: 5173 }, viewerId: 'a' });
    expect(stages(explicit).at(-1)).toBe('needs-approval');
    await host.close();
  });

  it.each([
    { ownerId: undefined, returningId: undefined, sameViewer: true, detached: false, refused: false },
    { ownerId: undefined, returningId: undefined, sameViewer: false, detached: false, refused: true },
    { ownerId: undefined, returningId: 'new', sameViewer: false, detached: false, refused: true },
    { ownerId: undefined, returningId: undefined, sameViewer: false, detached: true, refused: false },
    { ownerId: 'owner', returningId: 'owner', sameViewer: false, detached: false, refused: false },
    { ownerId: 'owner', returningId: undefined, sameViewer: false, detached: false, refused: true },
    { ownerId: 'owner', returningId: 'other', sameViewer: true, detached: false, refused: true },
  ])('resumed tab ownership: %j', async ({ ownerId, returningId, sameViewer, detached, refused }) => {
    const { host, ctx } = make();
    const owner = fakeViewer('Owner browser');
    await host.open(ctx, owner, { port: 5173 }, { viewerId: ownerId });
    if (detached) host.detach(ctx.runId, owner);
    const returning = sameViewer ? owner : fakeViewer();
    returning.messages.length = 0;
    await host.open(ctx, returning, { port: 5173 }, { viewerId: returningId, resume: true });
    if (refused) {
      expect(returning.messages).toEqual([{ t: 'replaced', by: 'Owner browser' }]);
      expect(returning.closed).toEqual([{ code: 4001, reason: 'replaced' }]);
    } else {
      expect(returning.messages.at(-1)).toMatchObject({ t: 'state', stage: 'needs-approval' });
      expect(returning.closed).toEqual([]);
    }
    await host.close();
  });

  it('reports browser ownership during launch and clears it after launch failure', async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const { host, ctx } = make(undefined, () => new Error('launch refused'), () => gate);
    await host.open(ctx, fakeViewer(), { port: 5173 });
    expect(host.ownsBrowser(ctx.runId)).toBe(false);
    const opening = host.open(ctx, fakeViewer(), { url: 'http://localhost:3000/' });
    expect(host.ownsBrowser(ctx.runId)).toBe(true);
    expect(host.ownsBrowser('absent')).toBe(false);
    finish();
    await opening;
    expect(host.ownsBrowser(ctx.runId)).toBe(false);
    await host.close();
  });

  it('routes owner ping, stop and keepWaiting controls and ignores an unattached viewer', async () => {
    const { host, ctx, devServers } = make();
    const viewer = fakeViewer();
    const stranger = fakeViewer();
    await host.handle(ctx, stranger, { t: 'ping', ts: 1 });
    expect(stranger.messages).toEqual([]);
    await host.handle(ctx, viewer, { t: 'open', target: { port: 5173 } });
    await host.handle(ctx, stranger, { t: 'ping', ts: 2 });
    expect(stranger.messages).toEqual([]);
    await host.handle(ctx, viewer, { t: 'ping', ts: 3 });
    expect(viewer.messages.at(-1)).toEqual({ t: 'pong', ts: 3 });
    await host.handle(ctx, viewer, { t: 'run', port: 5173 });
    devServers[0]!.set('stalled');
    await host.handle(ctx, viewer, { t: 'keepWaiting', port: 5173 });
    expect(devServers[0]!.state).toBe('starting');
    await host.handle(ctx, viewer, { t: 'stop', port: 5173 });
    expect(devServers[0]!.stop).toHaveBeenCalledWith('user');
    expect(viewer.messages.at(-1)).toMatchObject({ t: 'state', stage: 'server-stopped' });
    await host.handle(ctx, viewer, { t: 'keepWaiting', port: 5173 });
    expect(devServers[0]!.state).toBe('stopped');
    await host.close();
  });

  it('shares a download across panes, throttles progress and relaunches each requested URL', async () => {
    let finish!: (path: string) => void;
    let progress!: (received: number, total: number) => void;
    const download = vi.fn(({ onProgress }: Parameters<NonNullable<PreviewHostDeps['download']>>[0]) => {
      progress = onProgress;
      return new Promise<string>(resolve => { finish = resolve; });
    });
    const { host, ctx, browsers } = make(undefined, undefined, undefined, { download });
    const a = fakeViewer(), b = fakeViewer();
    const other = { ...ctx, runId: 'run-2' };
    await host.open(ctx, a, { url: 'http://localhost:3000/a' });
    await host.open(other, b, { url: 'http://localhost:3000/b' });
    const first = host.handle(ctx, a, { t: 'download' });
    const second = host.handle(other, b, { t: 'download' });
    expect(download).toHaveBeenCalledTimes(1);
    expect(a.messages.at(-1)).toEqual({ t: 'state', stage: 'downloading', received: 0, total: 0 });
    progress(1, 10);
    progress(2, 10);
    await vi.advanceTimersByTimeAsync(249);
    progress(3, 10);
    await vi.advanceTimersByTimeAsync(1);
    progress(4, 10);
    progress(10, 10);
    for (const viewer of [a, b]) {
      expect(viewer.messages.filter(msg => msg.t === 'downloadProgress')).toEqual([
        { t: 'downloadProgress', received: 1, total: 10 },
        { t: 'downloadProgress', received: 4, total: 10 },
        { t: 'downloadProgress', received: 10, total: 10 },
      ]);
    }
    finish('/cache/chrome');
    await Promise.all([first, second]);
    expect(navigations(browsers[0]!)).toEqual(['http://localhost:3000/a', 'http://localhost:3000/a']);
    expect(navigations(browsers[1]!)).toEqual(['http://localhost:3000/b', 'http://localhost:3000/b']);
    await host.close();
  });

  it.each([new Error('network refused'), 'download refused'])('reports download failure %s and permits a new download', async error => {
    const download = vi.fn().mockRejectedValue(error);
    const { host, ctx } = make(undefined, undefined, undefined, { download });
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.handle(ctx, viewer, { t: 'download' });
    expect(viewer.messages.at(-1)).toEqual({
      t: 'state', stage: 'download-failed', error: String(error instanceof Error ? error.message : error),
      installCommand: installCommand('linux', 'ID=ubuntu\n'),
    });
    await flush();
    await host.handle(ctx, viewer, { t: 'download' });
    expect(download).toHaveBeenCalledTimes(2);
    await host.close();
  });

  it('cancelDownload aborts the shared download and returns to the install prompt', async () => {
    let signal!: AbortSignal;
    const download: NonNullable<PreviewHostDeps['download']> = opts => {
      signal = opts.signal;
      return new Promise<string>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    };
    const { host, ctx } = make(undefined, undefined, undefined, { download });
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    const pending = host.handle(ctx, viewer, { t: 'download' });
    await host.handle(ctx, viewer, { t: 'cancelDownload' });
    await pending;
    expect(signal.aborted).toBe(true);
    expect(viewer.messages.at(-1)).toEqual({
      t: 'state', stage: 'chromium-missing', canDownload: false, installCommand: installCommand('linux', 'ID=ubuntu\n'),
    });
    await host.close();
  });

  it('refuses unknown registrations and absent approvals without creating a server', async () => {
    const { host, ctx, devServers } = make();
    expect(await host.stopPreview('absent', { port: 5173 })).toMatchObject({ ok: false, code: 'approval_required' });
    await host.open(ctx, fakeViewer(), { port: 5173 });
    expect(await host.stopPreview(ctx.runId, { port: 3000 })).toMatchObject({ ok: false, code: 'not_registered' });
    expect(await host.stopPreview(ctx.runId, { port: 5173, restart: true })).toMatchObject({ ok: false, code: 'approval_required' });
    const lifetime = new AbortController();
    lifetime.abort();
    expect(await host.stopPreview(ctx.runId, { port: 5173 }, lifetime.signal)).toMatchObject({ ok: false, code: 'unavailable' });
    expect(devServers).toEqual([]);
    await host.close();
  });

  it('forgets an adoption when another task takes ownership of its port', async () => {
    const { host, ctx, answering, devServers } = make();
    const viewer = fakeViewer();
    answering.add(5173);
    await host.open(ctx, viewer, { port: 5173 });
    answering.clear();
    const other = { ...ctx, runId: 'run-2', title: 'Other task' };
    await host.open(other, fakeViewer(), { port: 5173 });
    await host.run(other.runId, 5173);
    await host.open(ctx, viewer, { port: 5173 });
    expect(viewer.messages.at(-1)).toEqual({ t: 'state', stage: 'port-held', server: server(5173), ownerTitle: 'Other task' });
    expect(await host.stopPreview(ctx.runId, { port: 5173 })).toMatchObject({ code: 'port_held' });
    await host.stop(other.runId, 5173, 'user');
    expect(await host.stopPreview(ctx.runId, { port: 5173 })).toMatchObject({ code: 'approval_required' });
    expect(devServers).toHaveLength(1);
    await host.close();
  });

  it('keeps ownership while stop is pending, then frees the port', async () => {
    const { host, ctx, devServers } = make();
    await host.open(ctx, fakeViewer(), { port: 5173 });
    await host.run(ctx.runId, 5173);
    let finish!: () => void;
    devServers[0]!.stop.mockImplementationOnce(async () => {
      devServers[0]!.set('stopped');
      await new Promise<void>(resolve => { finish = resolve; });
    });
    const stopping = host.stop(ctx.runId, 5173, 'user');
    expect(host.portOwner(5173)).toEqual({ runId: ctx.runId, title: ctx.title });
    const viewer = fakeViewer();
    await host.open({ ...ctx, runId: 'run-2' }, viewer, { port: 5173 });
    expect(viewer.messages.at(-1)).toMatchObject({ stage: 'port-held', ownerTitle: ctx.title });
    finish();
    await stopping;
    expect(host.portOwner(5173)).toBeUndefined();
    expect(host.ownsServer(ctx.runId, 5173)).toBe(false);
    await host.close();
  });

  it('treats a failed port probe as silent and streams an unregistered port without approval', async () => {
    const { host, ctx, probe, browsers, devServers } = make();
    const viewer = fakeViewer();
    probe.mockRejectedValueOnce(new Error('probe refused'));
    await host.open(ctx, viewer, { port: 5173 });
    expect(viewer.messages.at(-1)).toMatchObject({ stage: 'needs-approval', wasRunning: false });
    await host.open(ctx, viewer, { port: 3000 });
    expect(navigations(browsers[0]!)).toEqual(['http://localhost:3000/']);
    expect(devServers).toHaveLength(0);
    expect(probe).toHaveBeenCalledTimes(1);
    await host.close();
  });

  it.each([
    { last: 'http://localhost:5173/form', expected: 'http://localhost:5173/form' },
    { last: 'http://localhost:3000/form', expected: 'http://localhost:5173/root' },
    { last: 'https://localhost:5173/form', expected: 'http://localhost:5173/root' },
    { last: 'http://other.example:5173/form', expected: 'http://localhost:5173/root' },
    { last: 'invalid URL', expected: 'http://localhost:5173/root' },
  ])('restart restores only a page from the registered origin: $last', async ({ last, expected }) => {
    const { host, ctx, browsers, devServers } = make([server(5173, { path: '/root' })]);
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run(ctx.runId, 5173);
    devServers[0]!.set('up');
    await flush();
    browsers[0]!.cdpFake.emit('Page.frameNavigated', { frame: { id: 'main', url: last } });
    await host.stop(ctx.runId, 5173, 'user');
    await host.run(ctx.runId, 5173);
    devServers[1]!.set('up');
    await flush();
    expect(navigations(browsers[0]!).at(-1)).toBe(expected);
    await host.close();
  });

  it('refuses an agent after a failed browser launch without repeated launch attempts', async () => {
    const { host, ctx, browsers } = make(undefined, () => new Error('launch denied'));
    const grant = host.grantAgent(ctx.runId, () => ctx);
    expect(await host.connectAgent(grant.token, fakeAgentClient()))
      .toEqual({ refused: 'The preview browser could not start' });
    expect(await host.connectAgent(grant.token, fakeAgentClient()))
      .toEqual({ refused: 'The preview browser failed; the owner can retry it from the preview pane' });
    expect(browsers).toEqual([]);
    await host.close();
  });

  it('reports a failed agent handshake and closes its idle browser later', async () => {
    const { host, ctx, browsers } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { url: 'http://localhost:3000/' });
    host.detach(ctx.runId, viewer);
    vi.spyOn(browsers[0]!.connection, 'call').mockResolvedValueOnce({ error: { code: -1, message: 'attach refused' } });
    const grant = host.grantAgent(ctx.runId, () => ctx);
    expect(await host.connectAgent(grant.token, fakeAgentClient()))
      .toEqual({ refused: 'Target.attachToBrowserTarget: attach refused' });
    expect(host.hasAgents(ctx.runId)).toBe(false);
    await vi.advanceTimersByTimeAsync(PREVIEW_BROWSER_IDLE_MS);
    expect(browsers[0]!.close).toHaveBeenCalledTimes(1);
    await host.close();
  });

  it.each(['success', 'failure'] as const)('a released pane receives no download %s or progress', async outcome => {
    let finish!: (path: string) => void;
    let fail!: (error: Error) => void;
    let progress!: (received: number, total: number) => void;
    const download: NonNullable<PreviewHostDeps['download']> = opts => {
      progress = opts.onProgress;
      return new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
    };
    const { host, ctx, browsers } = make(undefined, undefined, undefined, { download });
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    const pending = host.handle(ctx, viewer, { t: 'download' });
    await host.release(ctx.runId);
    const messages = [...viewer.messages];
    progress(10, 10);
    if (outcome === 'success') finish('/cache/chrome');
    else fail(new Error('download refused'));
    await pending;
    expect(viewer.messages).toEqual(messages);
    expect(browsers).toHaveLength(0);
    await host.close();
  });

  it('downloads without a prior URL start a browser without navigating', async () => {
    const { host, ctx, browsers } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.handle(ctx, viewer, { t: 'download' });
    expect(browsers).toHaveLength(1);
    expect(navigations(browsers[0]!)).toEqual([]);
    expect(host.ownsBrowser(ctx.runId)).toBe(true);
    await host.close();
  });

  it.each(['viewer', 'port', 'release'] as const)('a stale open probe cannot override a later %s change', async change => {
    const { host, ctx, probe, browsers } = make([server(5173), server(3000)]);
    const viewer = fakeViewer();
    let finish!: (answer: boolean) => void;
    probe.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const opening = host.open(ctx, viewer, { port: 5173 });
    if (change === 'viewer') await host.open(ctx, fakeViewer(), { port: 3000 });
    else if (change === 'port') await host.open(ctx, viewer, { port: 3000 });
    else await host.release(ctx.runId);
    const messages = [...viewer.messages];
    finish(true);
    await opening;
    expect(viewer.messages).toEqual(messages);
    expect(browsers).toHaveLength(0);
    expect(host.portOwner(5173)).toBeUndefined();
    await host.close();
  });

  it('agent stop preserves approval through stop and crash and reports Stopped', async () => {
    const { host, ctx, devServers, store } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    expect(await host.stopPreview('run-1', { port: 5173, restart: true })).toMatchObject({ ok: false, code: 'approval_required' });
    await host.run('run-1', 5173);
    expect(await host.stopPreview('run-1', { port: 5173 })).toMatchObject({ ok: true, code: 'stopped' });
    expect(store.stateEvents().at(-1)).toMatchObject({ state: 'stopped' });
    expect(stages(viewer).at(-1)).toBe('server-stopped');
    store.getRun('run-1')!.previewServers = [server(5173, { label: 'renamed' })];
    expect(await host.stopPreview('run-1', { port: 5173, restart: true })).toMatchObject({ ok: true, code: 'restarted' });
    devServers[1]!.set('exited');
    expect(await host.stopPreview('run-1', { port: 5173, restart: true })).toMatchObject({ ok: true, code: 'restarted' });
    expect(devServers).toHaveLength(3);
    expect(devServers.map(dev => dev.opts.server.command)).toEqual(['npm run dev', 'npm run dev', 'npm run dev']);
  });

  it.each(['command', 'cwd', 'path'] as const)('agent restart requires owner approval after %s changes', async field => {
    const { host, ctx, devServers, store } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run('run-1', 5173);
    store.getRun('run-1')!.previewServers = [server(5173, { [field]: 'changed' })];
    await host.replaced('run-1', 5173);
    expect(await host.stopPreview('run-1', { port: 5173, restart: true })).toMatchObject({ ok: false, code: 'approval_required', hint: expect.stringContaining('Run and open') });
    expect(devServers[0]!.state).toBe('stopped');
    expect(devServers).toHaveLength(1);
    expect(stages(viewer).at(-1)).toBe('needs-approval');
  });

  describe.each(['stop', 'probe'] as const)('restart approval recheck after %s', seam => {
    it.each(['command', 'cwd', 'path', 'registration'] as const)('refuses restart when approved %s changes', async field => {
      const { host, ctx, devServers, store, probe } = make();
      await host.open(ctx, fakeViewer(), { port: 5173 });
      await host.run('run-1', 5173);
      const changeRegistration = () => {
        store.getRun('run-1')!.previewServers = field === 'registration' ? [] : [server(5173, { [field]: 'changed' })];
      };
      if (seam === 'stop') {
        devServers[0]!.stop.mockImplementationOnce(async reason => {
          devServers[0]!.stopReason = reason;
          devServers[0]!.set('stopped');
          changeRegistration();
        });
      } else {
        probe.mockImplementationOnce(async () => {
          changeRegistration();
          return false;
        });
      }
      expect(await host.stopPreview('run-1', { port: 5173, restart: true }))
        .toMatchObject({ ok: false, code: 'approval_required' });
      expect(devServers).toHaveLength(1);
      expect(devServers[0]!.state).toBe('stopped');
      await host.close();
    });
  });

  it('agent refuses adopted servers, other runs and a newly occupied restart port', async () => {
    const { host, ctx, devServers, answering } = make();
    answering.add(5173);
    await host.open(ctx, fakeViewer(), { port: 5173 });
    expect(await host.stopPreview('run-1', { port: 5173 })).toMatchObject({ code: 'adopted', hint: expect.any(String) });
    answering.clear();
    await host.open(ctx, fakeViewer(), { port: 5173 });
    await host.run('run-1', 5173);
    expect(await host.stopPreview('run-2', { port: 5173 })).toMatchObject({ code: 'port_held' });
    expect(devServers[0]!.stop).not.toHaveBeenCalled();
    await host.stopPreview('run-1', { port: 5173 });
    answering.add(5173);
    expect(await host.stopPreview('run-1', { port: 5173, restart: true })).toMatchObject({ code: 'port_in_use' });
    expect(devServers).toHaveLength(1);
  });

  it.each(['replace', 'release', 'revoke'] as const)('agent restart cannot outlive concurrent %s or orphan the stopping process', async action => {
    const { host, ctx, devServers, store } = make();
    await host.open(ctx, fakeViewer(), { port: 5173 });
    await host.run('run-1', 5173);
    const dev = devServers[0]!;
    let finish!: () => void;
    dev.stop.mockImplementation(() => new Promise<void>(resolve => { finish = () => { dev.set('stopped'); resolve(); }; }));
    const lifetime = new AbortController();
    const restarting = host.stopPreview('run-1', { port: 5173, restart: true }, lifetime.signal);
    await Promise.resolve();
    let cleanup: Promise<void> | undefined;
    if (action === 'replace') {
      store.getRun('run-1')!.previewServers = [server(5173, { command: 'changed' })];
      cleanup = host.replaced('run-1', 5173);
      await host.run('run-1', 5173);
    } else if (action === 'release') cleanup = host.release('run-1');
    else lifetime.abort();
    if (action === 'release') {
      await host.open({ ...ctx, runId: 'run-2' }, fakeViewer(), { port: 5173 });
      await host.run('run-2', 5173);
    }
    expect(devServers).toHaveLength(1);
    expect(dev.stop).toHaveBeenCalledTimes(1);
    finish();
    await cleanup;
    expect((await restarting).ok).toBe(false);
    expect(devServers).toHaveLength(1);
    expect(dev.state).toBe('stopped');
  });

  it.each(['replace', 'release', 'revoke', 'other-owner', 'concurrent-restart'] as const)('rechecks authority after the restart probe: %s', async action => {
    const { host, ctx, devServers, store, probe } = make();
    await host.open(ctx, fakeViewer(), { port: 5173 });
    await host.run('run-1', 5173);
    let finish!: (answering: boolean) => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    probe.mockImplementationOnce(() => { entered(); return new Promise<boolean>(resolve => { finish = resolve; }); });
    const lifetime = new AbortController();
    const restarting = host.stopPreview('run-1', { port: 5173, restart: true }, lifetime.signal);
    await ready;
    if (action === 'replace') {
      store.getRun('run-1')!.previewServers = [server(5173, { command: 'changed' })];
      await host.replaced('run-1', 5173);
    } else if (action === 'release') await host.release('run-1');
    else if (action === 'revoke') lifetime.abort();
    else if (action === 'other-owner') {
      await host.open({ ...ctx, runId: 'run-2' }, fakeViewer(), { port: 5173 });
      await host.run('run-2', 5173);
    } else {
      expect(await host.stopPreview('run-1', { port: 5173, restart: true })).toMatchObject({ code: 'restarted' });
    }
    const count = devServers.length;
    finish(false);
    expect((await restarting).ok).toBe(false);
    expect(devServers).toHaveLength(count);
    if (action === 'other-owner' || action === 'concurrent-restart') expect(devServers[1]!.stop).not.toHaveBeenCalled();
  });

  it('answers open on a silent registered port with needs-approval and spawns nothing', async () => {
    const { host, ctx, devServers, browsers } = make([server(5173, { answeredAtRegistration: true })]);
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    expect(viewer.messages).toEqual([{ t: 'state', stage: 'needs-approval', server: server(5173, { answeredAtRegistration: true }), wasRunning: true }]);
    expect(devServers).toHaveLength(0);
    expect(browsers).toHaveLength(0);
  });

  it('owns a run\'s browser from launch until it is closed, so the boot sweep spares it', async () => {
    const { host, ctx } = make([server(5173, { answeredAtRegistration: true })]);
    expect(host.ownsBrowser('run-1')).toBe(false);
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { url: 'http://localhost:3000/' });
    await flush();
    expect(host.ownsBrowser('run-1')).toBe(true);
    await host.release('run-1');
    expect(host.ownsBrowser('run-1')).toBe(false);
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
    expect(viewer.messages.at(-1)).toMatchObject({ t: 'state', stage: 'server-starting', attempt: 0, logTail: ['ready in 300 ms'] });

    devServers[0]!.attempt();
    expect(viewer.messages.at(-1)).toMatchObject({ t: 'state', stage: 'server-starting', attempt: 1, logTail: ['ready in 300 ms'] });

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

  it('a late open probe cannot replace a newly restarted owned process with an adoption', async () => {
    const { host, ctx, devServers, probe } = make();
    await host.open(ctx, fakeViewer(), { port: 5173 });
    await host.run('run-1', 5173);
    await host.stopPreview('run-1', { port: 5173 });
    let finish!: (answering: boolean) => void;
    probe.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const opening = host.open(ctx, fakeViewer(), { port: 5173 });
    await host.stopPreview('run-1', { port: 5173, restart: true });
    finish(true);
    await opening;
    await host.release('run-1');
    expect(devServers[1]!.stop).toHaveBeenCalledWith('release');
  });

  it('agent restart after the no-viewer idle deadline always receives another cleanup deadline', async () => {
    const { host, ctx, devServers } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run('run-1', 5173);
    host.detach('run-1', viewer);
    await vi.advanceTimersByTimeAsync(PREVIEW_SERVER_IDLE_MS);
    expect(devServers[0]!.stop).toHaveBeenCalledWith('idle');
    expect(vi.getTimerCount()).toBe(0);
    for (let index = 1; index <= 2; index++) {
      expect(await host.stopPreview('run-1', { port: 5173, restart: true })).toMatchObject({ code: 'restarted' });
      await vi.advanceTimersByTimeAsync(PREVIEW_SERVER_IDLE_MS - 1);
      expect(devServers[index]!.stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(devServers[index]!.stop).toHaveBeenCalledWith('idle');
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('agent restart preserves existing server and browser idle deadlines', async () => {
    const { host, ctx, devServers, browsers } = make([server(5173), server(5174)]);
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run('run-1', 5173);
    devServers[0]!.set('up');
    await flush();
    await host.run('run-1', 5174);
    host.detach('run-1', viewer);
    await vi.advanceTimersByTimeAsync(PREVIEW_BROWSER_IDLE_MS - 1);
    expect(await host.stopPreview('run-1', { port: 5173, restart: true })).toMatchObject({ code: 'restarted' });
    await vi.advanceTimersByTimeAsync(1);
    expect(browsers[0]!.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(PREVIEW_SERVER_IDLE_MS - PREVIEW_BROWSER_IDLE_MS);
    expect(devServers[1]!.stop).toHaveBeenCalledWith('idle');
    expect(devServers[2]!.stop).toHaveBeenCalledWith('idle');
  });

  it('a returning viewer cancels the cleanup deadline armed by an agent restart', async () => {
    const { host, ctx, devServers } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run('run-1', 5173);
    host.detach('run-1', viewer);
    await vi.advanceTimersByTimeAsync(PREVIEW_SERVER_IDLE_MS);
    await host.stopPreview('run-1', { port: 5173, restart: true });
    await host.open(ctx, fakeViewer(), { port: 5173 });
    await vi.advanceTimersByTimeAsync(PREVIEW_SERVER_IDLE_MS);
    expect(devServers[1]!.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
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

  it('a re-registration with a new command stops the old server and asks for approval of the new one', async () => {
    const servers = [server(5173)];
    const { host, ctx, devServers } = make(servers);
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run('run-1', 5173);
    devServers[0]!.set('up');
    await flush();

    // The agent re-registered :5173 with another command; the store now holds the new one.
    servers[0] = server(5173, { command: 'npm run dev -- --host' });
    await host.replaced('run-1', 5173);
    expect(devServers[0]!.stop).toHaveBeenCalledWith('release');
    expect(viewer.messages.at(-1)).toEqual({ t: 'state', stage: 'needs-approval', server: server(5173, { command: 'npm run dev -- --host' }), wasRunning: false });
    // Nothing runs the new command until the owner approves it.
    expect(devServers).toHaveLength(1);
    await host.run('run-1', 5173);
    expect(devServers).toHaveLength(2);
    expect(devServers[1]!.opts.server.command).toBe('npm run dev -- --host');
  });

  it('a newer open wins over a show still waiting for Chromium: the old target never navigates', async () => {
    let letLaunch!: () => void;
    const gate = new Promise<void>(resolve => (letLaunch = resolve));
    const { host, ctx, answering, browsers } = make([server(5173), server(3000)], undefined, () => gate);
    answering.add(5173);
    const viewer = fakeViewer();
    const first = host.open(ctx, viewer, { port: 5173 });
    await flush();
    // The owner switches to the silent :3000 while :5173 is still waiting for the browser.
    await host.open(ctx, viewer, { port: 3000 });
    expect(viewer.messages.at(-1)).toMatchObject({ t: 'state', stage: 'needs-approval', server: { port: 3000 } });

    letLaunch();
    await first;
    await flush();
    expect(navigations(browsers[0]!)).toEqual([]);
    expect(viewer.messages.at(-1)).toMatchObject({ t: 'state', stage: 'needs-approval', server: { port: 3000 } });
  });

  it('a run deleted while its Chromium is still launching waits for that browser before deleting the profile', async () => {
    let letLaunch!: () => void;
    const gate = new Promise<void>(resolve => (letLaunch = resolve));
    const { host, ctx, answering, browsers } = make(undefined, undefined, () => gate);
    answering.add(5173);
    const viewer = fakeViewer();
    const opening = host.open(ctx, viewer, { port: 5173 });
    await flush();
    let released = false;
    const releasing = host.release('run-1', { deleteProfile: true }).then(() => { released = true; });
    await flush();
    expect(released).toBe(false);

    letLaunch();
    await flush();
    // The launch that lost the race closes its browser, and release waits for it to exit.
    expect(browsers[0]!.close).toHaveBeenCalled();
    expect(released).toBe(false);
    browsers[0]!.exit({ stderrTail: '' });
    await releasing;
    await opening;
    expect(existsSync(join(ctx.dataDir, 'preview', 'run-1'))).toBe(false);
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
    expect(viewer.messages.at(-1)).toEqual({ t: 'state', stage: 'browser-exited', reason: 'exited', signal: 'SIGSEGV', stderrTail: 'Aw, snap', serverUp: true });

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
    expect(viewer.messages.at(-1)).toEqual({ t: 'state', stage: 'chromium-missing', installCommand: installCommand('linux', 'ID=ubuntu\n'), canDownload: false });

    installed = true;
    await host.handle(ctx, viewer, { t: 'download' });
    expect(viewer.messages).toContainEqual({ t: 'downloadProgress', received: 10, total: 10 });
    expect(navigations(browsers[0]!)).toEqual(['http://localhost:5173/']);
  });

  it('a launch that times out or exits names why above the stderr tail', async () => {
    const { host, ctx, answering } = make(undefined, () => new ChromiumError('timeout', 'dbus noise', 'Chromium did not open its DevTools port in time'));
    answering.add(5173);
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    expect(viewer.messages.at(-1)).toEqual({
      t: 'state',
      stage: 'browser-exited',
      reason: 'timeout',
      stderrTail: 'Chromium did not open its DevTools port in time\ndbus noise',
      serverUp: true,
    });
  });

  it('a launch that exits early reports its exit code (#1474)', async () => {
    const { host, ctx, answering } = make(undefined, () => new ChromiumError('exited', 'boom', 'Chromium exited (3)', { exitCode: 3 }));
    answering.add(5173);
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    expect(viewer.messages.at(-1)).toEqual({
      t: 'state',
      stage: 'browser-exited',
      reason: 'exited',
      exitCode: 3,
      stderrTail: 'Chromium exited (3)\nboom',
      serverUp: true,
    });
  });

  it('a running Chromium that exits with a code reports the code, not a signal (#1474)', async () => {
    const { host, ctx, devServers, browsers } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run('run-1', 5173);
    devServers[0]!.set('up');
    await flush();
    browsers[0]!.exit({ exitCode: 21, stderrTail: 'out of memory' });
    await flush();
    expect(viewer.messages.at(-1)).toEqual({ t: 'state', stage: 'browser-exited', reason: 'exited', exitCode: 21, stderrTail: 'out of memory', serverUp: true });
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

  it('a binary that vanished after resolution (not-installed) offers the download, and the next open tries again', async () => {
    let missing = true;
    const { host, ctx, answering, browsers } = make(undefined, () => (missing ? new ChromiumError('not-installed', '', 'spawn ENOENT') : undefined));
    answering.add(5173);
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    expect(viewer.messages.at(-1)).toEqual({ t: 'state', stage: 'chromium-missing', installCommand: installCommand('linux', 'ID=ubuntu\n'), canDownload: false });
    missing = false;
    await host.open(ctx, viewer, { port: 5173 });
    expect(browsers).toHaveLength(1);
  });

  it('Start again after an idle stop reopens the page the owner was on (5.9)', async () => {
    const { host, ctx, devServers, browsers } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run('run-1', 5173);
    devServers[0]!.set('up');
    await flush();
    browsers[0]!.cdpFake.emit('Page.frameNavigated', { frame: { id: 'main', url: 'http://localhost:5173/settings' } });
    host.detach('run-1', viewer);
    await vi.advanceTimersByTimeAsync(PREVIEW_SERVER_IDLE_MS);

    const back = fakeViewer();
    await host.open(ctx, back, { port: 5173 });
    expect(back.messages.at(-1)).toEqual({ t: 'state', stage: 'server-stopped', server: server(5173), reason: 'idle', lastUrl: 'http://localhost:5173/settings' });

    await host.handle(ctx, back, { t: 'run', port: 5173 });
    devServers[1]!.set('up');
    await flush();
    expect(navigations(browsers[1]!)).toEqual(['http://localhost:5173/settings']);
  });

  it('a reconnecting pane resumes the live page instead of navigating back to the root', async () => {
    const { host, ctx, devServers, browsers } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run('run-1', 5173);
    devServers[0]!.set('up');
    await flush();
    browsers[0]!.cdpFake.emit('Page.frameNavigated', { frame: { id: 'main', url: 'http://localhost:5173/settings' } });

    const again = fakeViewer();
    await host.open(ctx, again, { port: 5173 });
    await flush();
    expect(navigations(browsers[0]!)).toEqual(['http://localhost:5173/']);
    browsers[0]!.cdpFake.emit('Page.screencastFrame', { data: 'AA==', sessionId: 9 });
    expect(again.messages.at(-1)).toEqual({ t: 'state', stage: 'streaming', adopted: false });
    expect(again.frames).toHaveLength(1);
  });

  describe('stream quality (hearsay-tools/cezarion#2066)', () => {
    const qualities = (browser: { cdpFake: ReturnType<typeof fakeCdp> }) => browser.cdpFake.sent('Page.startScreencast').map(call => call.params.quality);

    it('streams the mode the open asked for, and an older open without one streams Normal', async () => {
      const { host, ctx, answering, browsers } = make();
      answering.add(5173);
      await host.handle(ctx, fakeViewer(), { t: 'open', target: { port: 5173 }, quality: 'high' });
      await flush();
      expect(qualities(browsers[0]!)).toEqual([100]);
      await host.handle(ctx, fakeViewer(), { t: 'open', target: { port: 5173 } });
      await flush();
      expect(qualities(browsers[0]!).at(-1)).toBe(60);
    });

    it('a switch restarts the stream on the same page: no navigation, the URL stays', async () => {
      const { host, ctx, answering, browsers } = make();
      answering.add(5173);
      const viewer = fakeViewer();
      await host.handle(ctx, viewer, { t: 'open', target: { port: 5173 } });
      await flush();
      browsers[0]!.cdpFake.emit('Page.frameNavigated', { frame: { id: 'main', url: 'http://localhost:5173/form' } });
      await host.handle(ctx, viewer, { t: 'quality', quality: 'high' });
      await flush();
      expect(qualities(browsers[0]!)).toEqual([60, 100]);
      expect(navigations(browsers[0]!)).toEqual(['http://localhost:5173/']);
      expect(browsers[0]!.cdpFake.sent('Page.reload')).toHaveLength(0);
    });

    it('a reconnect at High resumes the live page at High', async () => {
      const { host, ctx, answering, browsers } = make();
      answering.add(5173);
      const first = fakeViewer();
      await host.handle(ctx, first, { t: 'open', target: { port: 5173 }, viewerId: 'pane', quality: 'high' });
      browsers[0]!.cdpFake.emit('Page.frameNavigated', { frame: { id: 'main', url: 'http://localhost:5173/cart' } });
      host.detach(ctx.runId, first);
      const again = fakeViewer();
      await host.handle(ctx, again, { t: 'open', target: { port: 5173 }, viewerId: 'pane', resume: true, quality: 'high' });
      await flush();
      expect(again.closed).toEqual([]);
      expect(navigations(browsers[0]!)).toEqual(['http://localhost:5173/']);
      expect(qualities(browsers[0]!).length).toBeGreaterThanOrEqual(2);
      expect(new Set(qualities(browsers[0]!))).toEqual(new Set([100]));
    });

    it('a viewer that is not the owner cannot change the mode', async () => {
      const { host, ctx, answering, browsers } = make();
      answering.add(5173);
      await host.handle(ctx, fakeViewer(), { t: 'open', target: { port: 5173 } });
      await flush();
      await host.handle(ctx, fakeViewer(), { t: 'quality', quality: 'high' });
      await flush();
      expect(qualities(browsers[0]!)).toEqual([60]);
    });
  });

  it('a reconnect to an adopted server resumes the live page too', async () => {
    const { host, ctx, answering, browsers } = make();
    answering.add(5173);
    await host.open(ctx, fakeViewer(), { port: 5173 });
    browsers[0]!.cdpFake.emit('Page.frameNavigated', { frame: { id: 'main', url: 'http://localhost:5173/cart' } });
    const again = fakeViewer();
    await host.open(ctx, again, { port: 5173 });
    expect(navigations(browsers[0]!)).toEqual(['http://localhost:5173/']);
    browsers[0]!.cdpFake.emit('Page.screencastFrame', { data: 'AA==', sessionId: 3 });
    expect(again.messages.at(-1)).toEqual({ t: 'state', stage: 'streaming', adopted: true });
  });

  describe('a port another task\'s cezar-owned server holds', () => {
    const other = (ctx: RunContext): RunContext => ({ ...ctx, runId: 'run-2', title: 'Fix the footer' });

    it('is never adopted or streamed at open: the pane says which task holds it', async () => {
      const { host, ctx, answering, devServers, browsers } = make();
      await host.open(ctx, fakeViewer(), { port: 5173 });
      await host.run('run-1', 5173);
      devServers[0]!.set('up');
      answering.add(5173);
      await flush();
      const launched = browsers.length;

      const viewer = fakeViewer();
      await host.open(other(ctx), viewer, { port: 5173 });
      await flush();
      expect(viewer.messages).toEqual([{ t: 'state', stage: 'port-held', server: server(5173), ownerTitle: 'Build the app' }]);
      expect(browsers).toHaveLength(launched);
      expect(viewer.frames).toHaveLength(0);
      expect(host.portOwner(5173)).toEqual({ runId: 'run-1', title: 'Build the app' });
    });

    it('is held while that server is still starting and silent', async () => {
      const { host, ctx } = make();
      await host.open(ctx, fakeViewer(), { port: 5173 });
      await host.run('run-1', 5173);
      const viewer = fakeViewer();
      await host.open(other(ctx), viewer, { port: 5173 });
      expect(viewer.messages.at(-1)).toEqual({ t: 'state', stage: 'port-held', server: server(5173), ownerTitle: 'Build the app' });
    });

    it('run refuses to spawn onto it and repeats port-held', async () => {
      const { host, ctx, devServers } = make();
      await host.open(ctx, fakeViewer(), { port: 5173 });
      await host.run('run-1', 5173);
      const viewer = fakeViewer();
      await host.open(other(ctx), viewer, { port: 5173 });
      viewer.messages.length = 0;
      await host.handle(other(ctx), viewer, { t: 'run', port: 5173 });
      expect(devServers).toHaveLength(1);
      expect(viewer.messages).toEqual([{ t: 'state', stage: 'port-held', server: server(5173), ownerTitle: 'Build the app' }]);
    });

    it('is free again once the owner stops it', async () => {
      const { host, ctx, devServers } = make();
      await host.open(ctx, fakeViewer(), { port: 5173 });
      await host.run('run-1', 5173);
      await host.stop('run-1', 5173, 'user');
      const viewer = fakeViewer();
      await host.open(other(ctx), viewer, { port: 5173 });
      expect(viewer.messages.at(-1)).toMatchObject({ t: 'state', stage: 'needs-approval' });
      await host.handle(other(ctx), viewer, { t: 'run', port: 5173 });
      expect(devServers).toHaveLength(2);
    });
  });

  describe('agent CDP connections (hearsay-tools/cezarion#784)', () => {
    const agentEvents = (store: ReturnType<typeof fakeStore>) =>
      store.events.filter(entry => entry.event.type === 'preview.agent-browser').map(entry => entry.event.state);
    const connect = async (host: PreviewHost, token: string) => {
      const client = fakeAgentClient();
      const link = await host.connectAgent(token, client);
      return { client, link };
    };

    it('refuses a token it never granted, or one revoked', async () => {
      const { host, ctx, browsers } = make();
      expect(await host.connectAgent('nope', fakeAgentClient())).toEqual({ refused: expect.stringContaining('no longer valid') });
      const grant = host.grantAgent(ctx.runId, () => ctx);
      expect(host.hasAgentGrant(grant.token)).toBe(true);
      grant.revoke();
      expect(host.hasAgentGrant(grant.token)).toBe(false);
      expect(await host.connectAgent(grant.token, fakeAgentClient())).toEqual({ refused: expect.stringContaining('no longer valid') });
      expect(browsers).toHaveLength(0);
    });

    it('refuses a run with no worktree, and starts nothing', async () => {
      const { host, ctx, browsers } = make();
      const grant = host.grantAgent(ctx.runId, () => undefined);
      expect(await host.connectAgent(grant.token, fakeAgentClient())).toEqual({ refused: expect.stringContaining('no worktree') });
      expect(browsers).toHaveLength(0);
    });

    it('starts Chromium for an agent with no pane open, records connected once, and keeps it while the agent stays', async () => {
      const { host, ctx, store, browsers } = make();
      const grant = host.grantAgent(ctx.runId, () => ctx);
      const first = await connect(host, grant.token);
      const second = await connect(host, grant.token);
      expect(browsers).toHaveLength(1);
      expect(browsers[0]!.connectionFake.requests.filter(r => r.method === 'Target.attachToBrowserTarget')).toHaveLength(2);
      expect(agentEvents(store)).toEqual(['connected']);
      await vi.advanceTimersByTimeAsync(PREVIEW_BROWSER_IDLE_MS * 3);
      expect(browsers[0]!.close).not.toHaveBeenCalled();
      expect(first.link).not.toHaveProperty('refused');
      expect(second.link).not.toHaveProperty('refused');
    });

    it('keeps a crash marker from just before connected until just after disconnected', async () => {
      const { host, ctx, store } = make();
      const marker = join(ctx.dataDir, 'preview', ctx.runId, 'agent-connected');
      const markedAtEvent: boolean[] = [];
      const append = store.appendEvent;
      store.appendEvent = (runId, event) => {
        if (event.type === 'preview.agent-browser') markedAtEvent.push(existsSync(marker));
        return append(runId, event);
      };
      const grant = host.grantAgent(ctx.runId, () => ctx);
      const { link } = await connect(host, grant.token);
      expect(host.hasAgents(ctx.runId)).toBe(true);
      (link as { close(): void }).close();
      expect(markedAtEvent).toEqual([true, true]);
      expect(existsSync(marker)).toBe(false);
      expect(host.hasAgents(ctx.runId)).toBe(false);
    });

    it('a disconnected the store cannot write keeps the marker for the next boot and still starts the idle timers', async () => {
      const { host, ctx, store, browsers } = make();
      const marker = join(ctx.dataDir, 'preview', ctx.runId, 'agent-connected');
      const grant = host.grantAgent(ctx.runId, () => ctx);
      const { link } = await connect(host, grant.token);
      store.appendEvent = () => { throw new Error('disk full'); };
      expect(() => (link as { close(): void }).close()).not.toThrow();
      expect(existsSync(marker)).toBe(true);
      await vi.advanceTimersByTimeAsync(PREVIEW_BROWSER_IDLE_MS);
      expect(browsers[0]!.close).toHaveBeenCalled();
    });

    it('records disconnected when the last agent leaves, then closes the idle browser after the browser idle time', async () => {
      const { host, ctx, store, browsers } = make();
      const grant = host.grantAgent(ctx.runId, () => ctx);
      const a = await connect(host, grant.token);
      const b = await connect(host, grant.token);
      (a.link as { close(): void }).close();
      expect(agentEvents(store)).toEqual(['connected']);
      (b.link as { close(): void }).close();
      expect(agentEvents(store)).toEqual(['connected', 'disconnected']);
      await vi.advanceTimersByTimeAsync(PREVIEW_BROWSER_IDLE_MS - 1);
      expect(browsers[0]!.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(browsers[0]!.close).toHaveBeenCalled();
    });

    it('a viewer leaving while an agent drives starts no idle timer, for the browser or a cezar-run server', async () => {
      const { host, ctx, browsers, devServers } = make();
      const viewer = fakeViewer();
      await host.handle(ctx, viewer, { t: 'open', target: { port: 5173 } });
      await host.handle(ctx, viewer, { t: 'run', port: 5173 });
      devServers[0]!.set('up');
      await flush();
      const grant = host.grantAgent(ctx.runId, () => ctx);
      const agent = await connect(host, grant.token);
      host.detach(ctx.runId, viewer);
      await vi.advanceTimersByTimeAsync(PREVIEW_SERVER_IDLE_MS + PREVIEW_BROWSER_IDLE_MS);
      expect(browsers[0]!.close).not.toHaveBeenCalled();
      expect(devServers[0]!.stop).not.toHaveBeenCalled();
      (agent.link as { close(): void }).close();
      await vi.advanceTimersByTimeAsync(PREVIEW_SERVER_IDLE_MS);
      expect(browsers[0]!.close).toHaveBeenCalled();
      expect(devServers[0]!.stop).toHaveBeenCalledWith('idle');
    });

    it("revoking the session's grant closes its sockets with 1008 and records disconnected", async () => {
      const { host, ctx, store } = make();
      const grant = host.grantAgent(ctx.runId, () => ctx);
      const { client } = await connect(host, grant.token);
      grant.revoke();
      expect(client.closed).toEqual([{ code: 1008, reason: "The agent's session ended" }]);
      expect(agentEvents(store)).toEqual(['connected', 'disconnected']);
    });

    it('release closes the agent sockets and the browser', async () => {
      const { host, ctx, store, browsers } = make();
      const grant = host.grantAgent(ctx.runId, () => ctx);
      const { client } = await connect(host, grant.token);
      await host.release(ctx.runId);
      expect(client.closed).toEqual([{ code: 1001, reason: 'The preview browser closed' }]);
      expect(agentEvents(store)).toEqual(['connected', 'disconnected']);
      expect(browsers[0]!.close).toHaveBeenCalled();
    });

    it('a Chromium exit closes the agent sockets with 1011, and a failed browser refuses the next agent without relaunching', async () => {
      const { host, ctx, browsers } = make();
      const grant = host.grantAgent(ctx.runId, () => ctx);
      const { client } = await connect(host, grant.token);
      browsers[0]!.exit({ signal: 'SIGSEGV', stderrTail: 'Aw, snap' });
      await flush();
      expect(client.closed).toEqual([{ code: 1011, reason: 'The preview browser exited' }]);
      expect(await host.connectAgent(grant.token, fakeAgentClient())).toEqual({ refused: expect.stringContaining('owner can retry') });
      expect(browsers).toHaveLength(1);
    });

    /** Holds the browser's answer to the next agent handshake until `release` runs. */
    const holdHandshake = (connection: CdpConnection) => {
      const call = connection.call;
      let release!: () => void;
      const held = new Promise<void>(resolve => (release = resolve));
      connection.call = async (method, params, sessionId) => {
        if (method === 'Target.attachToBrowserTarget') {
          connection.call = call;
          await held;
        }
        return call(method, params, sessionId);
      };
      return () => release();
    };

    it('a session revoked during the handshake leaves the idle timer armed, so the browser closes', async () => {
      const { host, ctx, store, browsers } = make();
      const viewer = fakeViewer();
      await host.handle(ctx, viewer, { t: 'open', target: { url: 'http://localhost:5173/' } });
      await flush();
      host.detach(ctx.runId, viewer);
      const release = holdHandshake(browsers[0]!.connection);
      const grant = host.grantAgent(ctx.runId, () => ctx);
      const client = fakeAgentClient();
      const pending = host.connectAgent(grant.token, client);
      await flush();
      grant.revoke();
      release();
      expect(await pending).toEqual({ refused: expect.any(String) });
      expect(agentEvents(store)).toEqual([]);
      await vi.advanceTimersByTimeAsync(PREVIEW_BROWSER_IDLE_MS);
      expect(browsers[0]!.close).toHaveBeenCalled();
    });

    it('an agent whose handshake outlives the last agent leaving keeps the browser', async () => {
      const { host, ctx, browsers } = make();
      const grant = host.grantAgent(ctx.runId, () => ctx);
      const first = await connect(host, grant.token);
      const release = holdHandshake(browsers[0]!.connection);
      const pending = host.connectAgent(grant.token, fakeAgentClient());
      await flush();
      (first.link as { close(): void }).close();
      release();
      expect(await pending).not.toHaveProperty('refused');
      await vi.advanceTimersByTimeAsync(PREVIEW_BROWSER_IDLE_MS * 2);
      expect(browsers[0]!.close).not.toHaveBeenCalled();
    });

    it('protects the page the pane streams from the agent', async () => {
      const { host, ctx } = make();
      const grant = host.grantAgent(ctx.runId, () => ctx);
      const { client, link } = await connect(host, grant.token);
      (link as { fromClient(text: string): void }).fromClient(JSON.stringify({ id: 1, method: 'Target.closeTarget', params: { targetId: 'PANE' } }));
      expect(client.sent).toEqual([{ id: 1, error: { code: -32000, message: "cezar refuses Target.closeTarget on the page the owner's preview pane shows." } }]);
    });

    it("opening the agent's page attaches the pane without navigating, and says agent-idle when no agent is connected", async () => {
      const { host, ctx, browsers } = make();
      const early = fakeViewer();
      await host.handle(ctx, early, { t: 'open', target: { agent: true } });
      expect(stages(early)).toEqual(['agent-idle']);
      expect(browsers).toHaveLength(0);
      host.detach(ctx.runId, early);
      const grant = host.grantAgent(ctx.runId, () => ctx);
      await connect(host, grant.token);
      const viewer = fakeViewer();
      await host.handle(ctx, viewer, { t: 'open', target: { agent: true } });
      await flush();
      expect(navigations(browsers[0]!)).toEqual([]);
      expect(browsers[0]!.cdpFake.sent('Page.startScreencast').length).toBeGreaterThan(0);
      expect(stages(viewer)).not.toContain('agent-idle');
    });

    describe("the pane follows the agent's page (agent-browser --pin-tab opens a tab of its own)", () => {
      type Link = { fromClient(text: string): void };
      const drive = async (link: unknown, id: number, method: string, params: Record<string, unknown>) => {
        (link as Link).fromClient(JSON.stringify({ id, method, params }));
        await flush();
      };
      const urls = (viewer: ReturnType<typeof fakeViewer>) => viewer.messages.flatMap(msg => (msg.t === 'url' ? [msg.url] : []));
      const setup = async () => {
        const made = make();
        const grant = made.host.grantAgent(made.ctx.runId, () => made.ctx);
        const { link } = await connect(made.host, grant.token);
        const viewer = fakeViewer();
        await made.host.handle(made.ctx, viewer, { t: 'open', target: { agent: true } });
        await flush();
        const browser = made.browsers[0]!;
        return { ...made, link, viewer, browser, conn: browser.connectionFake };
      };

      it('reuses the followed page session on another open and ignores unrelated detach events', async () => {
        const { host, ctx, link, viewer, conn } = await setup();
        await drive(link, 1, 'Target.createTarget', { url: 'about:blank' });
        const page = conn.pages.get('S1')!;
        conn.emit({ method: 'Target.detachedFromTarget', sessionId: 'B1', params: { sessionId: 'S1' } });
        conn.emit({ method: 'Target.detachedFromTarget', params: { sessionId: 'other' } });
        conn.emit({ method: 'Target.targetDestroyed', params: { sessionId: 'S1' } });
        expect(page.cdp.close).not.toHaveBeenCalled();
        await host.open(ctx, viewer, { agent: true });
        expect(conn.requests.filter(r => r.method === 'Target.attachToTarget' && r.sessionId === undefined)).toHaveLength(1);
        expect(urls(viewer).at(-1)).toBe('http://localhost/NEW');
        await host.close();
      });

      it('detaches a followed page whose session fails to initialise and keeps the home stream', async () => {
        const { host, link, browser, conn } = await setup();
        const broken = fakeCdp();
        vi.mocked(broken.cdp.send).mockRejectedValue(new Error('page closed'));
        vi.spyOn(browser.connection, 'session').mockReturnValueOnce(broken.cdp);
        await drive(link, 1, 'Target.createTarget', { url: 'about:blank' });
        expect(conn.requests).toContainEqual({ method: 'Target.detachFromTarget', params: { sessionId: 'S1' }, sessionId: undefined });
        expect(browser.cdpFake.cdp.close).not.toHaveBeenCalled();
        expect(browser.cdpFake.sent('Page.startScreencast').length).toBeGreaterThan(0);
        await host.close();
      });

      it("streams the tab the agent creates, from a session of cezar's own on it", async () => {
        const { link, viewer, conn } = await setup();
        await drive(link, 1, 'Target.createTarget', { url: 'about:blank' });
        const own = conn.requests.filter(r => r.method === 'Target.attachToTarget' && r.sessionId === undefined);
        expect(own.map(r => r.params)).toEqual([{ targetId: 'NEW', flatten: true }]);
        expect(conn.pages.get('S1')!.sent('Page.startScreencast').length).toBeGreaterThan(0);
        expect(urls(viewer).at(-1)).toBe('http://localhost/NEW');
      });

      it("streams the agent's own tab at the mode the pane chose (hearsay-tools/cezarion#2066)", async () => {
        const { host, ctx, link, viewer, conn } = await setup();
        await host.handle(ctx, viewer, { t: 'quality', quality: 'high' });
        await drive(link, 1, 'Target.createTarget', { url: 'about:blank' });
        const starts = conn.pages.get('S1')!.sent('Page.startScreencast');
        expect(starts.length).toBeGreaterThan(0);
        expect(new Set(starts.map(call => call.params.quality))).toEqual(new Set([100]));
      });

      it('ignores a target that is not a page', async () => {
        const { link, conn } = await setup();
        await drive(link, 1, 'Target.attachToTarget', { targetId: 'W1', flatten: true });
        expect(conn.pages.size).toBe(0);
      });

      it("a server open leaves the agent's tab alone and streams cezar's own page again", async () => {
        const { host, ctx, link, viewer, browser, conn } = await setup();
        await drive(link, 1, 'Target.createTarget', { url: 'about:blank' });
        const before = browser.cdpFake.sent('Page.startScreencast').length;
        await host.handle(ctx, viewer, { t: 'open', target: { url: 'http://localhost:5173/' } });
        await flush();
        expect(conn.pages.get('S1')!.cdp.close).toHaveBeenCalled();
        expect(conn.requests.some(r => r.method === 'Target.closeTarget')).toBe(false);
        expect(browser.cdpFake.sent('Page.startScreencast').length).toBeGreaterThan(before);
        expect(navigations(browser)).toEqual(['http://localhost:5173/']);
      });

      it('falls back to the home page when the agent closes the tab the pane followed', async () => {
        const { link, viewer, browser, conn } = await setup();
        await drive(link, 1, 'Target.createTarget', { url: 'about:blank' });
        const before = browser.cdpFake.sent('Page.startScreencast').length;
        conn.emit({ method: 'Target.detachedFromTarget', params: { sessionId: 'S1', targetId: 'NEW' } });
        await flush();
        expect(conn.pages.get('S1')!.cdp.close).toHaveBeenCalled();
        expect(browser.cdpFake.sent('Page.startScreencast').length).toBeGreaterThan(before);
        // A later open of the agent's page shows the home page, not the closed tab.
        expect(urls(viewer)).toContain('http://localhost/NEW');
      });

      it('shows the home page again when the agent closed its tab while the pane looked elsewhere', async () => {
        const { host, ctx, link, viewer, browser, conn } = await setup();
        await host.handle(ctx, viewer, { t: 'open', target: { url: 'http://localhost:5173/' } });
        await drive(link, 1, 'Target.createTarget', { url: 'about:blank' });
        conn.gone.add('NEW');
        const before = browser.cdpFake.sent('Page.startScreencast').length;
        await host.handle(ctx, viewer, { t: 'open', target: { agent: true } });
        await flush();
        // The pane cleared its stage for this open: a restarted stream brings it a first frame.
        expect(browser.cdpFake.sent('Page.startScreencast').length).toBeGreaterThan(before);
        await host.handle(ctx, viewer, { t: 'open', target: { agent: true } });
        await flush();
        expect(conn.requests.filter(r => r.method === 'Target.attachToTarget' && r.sessionId === undefined)).toHaveLength(1);
      });
    });
  });
});
