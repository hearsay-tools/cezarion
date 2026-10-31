import { describe, expect, it, vi } from 'vitest';
import { PREVIEW_SERVER_IDLE_MS } from './host.ts';
import { fakeViewer } from './preview.testkit.ts';
import { flush, server, useHostFixture } from './host.testkit.ts';

describe('PreviewHost server events and controls', () => {
  const make = useHostFixture();

  it('ignores controls for absent runs and unregistered ports, and never runs a second live server', async () => {
    const { host, ctx, devServers } = make();
    await host.run('absent', 5173);
    expect(await host.stop('absent', 5173, 'user')).toBe(false);
    host.keepWaiting('absent', 5173);
    host.detach('absent', fakeViewer());
    expect(host.ownsServer('absent', 5173)).toBe(false);
    expect(host.hasAgents('absent')).toBe(false);
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run(ctx.runId, 3000);
    expect(devServers).toHaveLength(0);
    await host.run(ctx.runId, 5173);
    await host.run(ctx.runId, 5173);
    expect(devServers).toHaveLength(1);
    devServers[0]!.set('stalled');
    host.keepWaiting(ctx.runId, 5173);
    expect(devServers[0]!.state).toBe('starting');
    host.detach(ctx.runId, fakeViewer());
    await vi.advanceTimersByTimeAsync(PREVIEW_SERVER_IDLE_MS);
    expect(devServers[0]!.stop).not.toHaveBeenCalled();
  });

  it('keeps the original start timestamp when reporting a live server again', async () => {
    const { host, ctx } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run(ctx.runId, 5173);
    const start = viewer.messages.at(-1);
    await vi.advanceTimersByTimeAsync(1000);
    await host.open(ctx, viewer, { port: 5173 });
    expect(viewer.messages.at(-1)).toEqual(start);
  });

  it.each([
    { state: 'exited' as const, exitCode: undefined, stopReason: undefined, extra: {} },
    { state: 'exited' as const, exitCode: 0, stopReason: undefined, extra: { exitCode: 0 } },
    { state: 'exited' as const, exitCode: 2, stopReason: 'user' as const, extra: { exitCode: 2 } },
    { state: 'stopped' as const, exitCode: 2, stopReason: 'user' as const, extra: { reason: 'user' } },
    { state: 'stopped' as const, exitCode: undefined, stopReason: 'idle' as const, extra: { reason: 'idle' } },
    { state: 'stopped' as const, exitCode: undefined, stopReason: 'release' as const, extra: {} },
  ])('records exactly the applicable transition fields: %j', async ({ state, exitCode, stopReason, extra }) => {
    const { host, ctx, devServers, store } = make();
    await host.open(ctx, fakeViewer(), { port: 5173 });
    await host.run(ctx.runId, 5173);
    const dev = devServers[0]!;
    if (exitCode !== undefined) dev.exitCode = exitCode;
    if (stopReason !== undefined) dev.stopReason = stopReason;
    dev.set(state);
    expect(store.stateEvents().at(-1)).toEqual({ type: 'preview.server-state', port: 5173, state, ...extra });
  });

  it('does not append events after the run has disappeared from the store', async () => {
    const { host, ctx, store, devServers } = make();
    await host.open(ctx, fakeViewer(), { port: 5173 });
    await host.run(ctx.runId, 5173);
    const events = [...store.events];
    vi.spyOn(store, 'getRun').mockReturnValue(undefined);
    devServers[0]!.set('stalled');
    expect(store.events).toEqual(events);
  });

  it('does not report attempts or transitions from a replaced process', async () => {
    const { host, ctx, devServers, store } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run(ctx.runId, 5173);
    const old = devServers[0]!;
    old.set('stalled');
    const stalled = [...viewer.messages];
    old.attempt();
    expect(viewer.messages).toEqual(stalled);
    await host.replaced(ctx.runId, 5173);
    await host.run(ctx.runId, 5173);
    const messages = [...viewer.messages], events = [...store.events];
    old.set('starting');
    old.attempt();
    expect(viewer.messages).toEqual(messages);
    expect(store.events).toEqual(events);
  });

  it('records a background server transition without overwriting the selected port', async () => {
    const { host, ctx, devServers, store } = make([server(5173), server(3000)]);
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run(ctx.runId, 5173);
    await host.open(ctx, viewer, { port: 3000 });
    const messages = [...viewer.messages];
    devServers[0]!.set('up');
    devServers[0]!.attempt();
    await flush();
    expect(viewer.messages).toEqual(messages);
    expect(store.stateEvents().at(-1)).toEqual({ type: 'preview.server-state', port: 5173, state: 'up' });
  });

  it('reopening an already-up owned server resumes its stream and reports non-adopted frames', async () => {
    const { host, ctx, devServers, browsers } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run(ctx.runId, 5173);
    devServers[0]!.set('up');
    await flush();
    const cdp = browsers[0]!.cdpFake;
    cdp.emit('Page.frameNavigated', { frame: { id: 'main', url: 'http://localhost:5173/' } });
    const starts = cdp.sent('Page.startScreencast').length;
    await host.open(ctx, viewer, { port: 5173 });
    await flush();
    expect(cdp.sent('Page.startScreencast').length).toBeGreaterThan(starts);
    cdp.emit('Page.screencastFrame', { data: 'AA==', sessionId: 1 });
    expect(viewer.messages.at(-1)).toEqual({ t: 'state', stage: 'streaming', adopted: false });
  });

  it('forwards page controls, tolerates missing sessions and ignores unavailable downloads', async () => {
    const { host, ctx, browsers } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.handle(ctx, viewer, { t: 'cancelDownload' });
    await host.handle(ctx, viewer, { t: 'quality', quality: 'high' });
    await host.handle(ctx, viewer, { t: 'reload' });
    expect(browsers).toHaveLength(0);
    await host.open(ctx, viewer, { url: 'http://localhost:3000/' });
    await host.handle(ctx, viewer, { t: 'reload' });
    expect(browsers[0]!.cdpFake.sent('Page.reload')).toHaveLength(1);
    vi.mocked(browsers[0]!.cdpFake.cdp.send).mockRejectedValueOnce(new Error('page disappeared'));
    await expect(host.handle(ctx, viewer, { t: 'reload' })).resolves.toBeUndefined();
  });
});
