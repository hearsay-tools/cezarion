import { describe, expect, it } from 'vitest';
import { fakeViewer } from './preview.testkit.ts';
import { flush, server, useHostFixture } from './host.testkit.ts';

describe('PreviewHost race boundaries', () => {
  const make = useHostFixture();

  it.each(['abort', 'release'] as const)('refuses a stop whose authority ends during teardown: %s', async action => {
    const { host, ctx, devServers } = make();
    await host.open(ctx, fakeViewer(), { port: 5173 });
    await host.run(ctx.runId, 5173);
    let finish!: () => void;
    let releasing: Promise<void> | undefined;
    const lifetime = new AbortController();
    devServers[0]!.stop.mockImplementationOnce(async () => {
      // Let stopServer register this teardown before release joins the same promise.
      await new Promise<void>(resolve => { finish = resolve; });
      devServers[0]!.set('stopped');
      if (action === 'abort') lifetime.abort();
      else releasing = host.release(ctx.runId);
    });
    const stopping = host.stopPreview(ctx.runId, { port: 5173, restart: false }, lifetime.signal);
    finish();
    expect(await stopping).toMatchObject({ ok: false, code: 'unavailable' });
    await releasing;
    expect(devServers).toHaveLength(1);
  });

  it('does not reuse an approval revoked during stop even if registration text stays unchanged', async () => {
    const { host, ctx, devServers } = make();
    await host.open(ctx, fakeViewer(), { port: 5173 });
    await host.run(ctx.runId, 5173);
    let finish!: () => void;
    devServers[0]!.stop.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      devServers[0]!.set('stopped');
    });
    const restarting = host.stopPreview(ctx.runId, { port: 5173, restart: true });
    const replacing = host.replaced(ctx.runId, 5173);
    finish();
    expect(await restarting).toMatchObject({ ok: false, code: 'approval_required' });
    await replacing;
    expect(devServers).toHaveLength(1);
  });

  it('keeps approval identity when a concurrent restart creates a new process', async () => {
    const { host, ctx, devServers, probe } = make();
    await host.open(ctx, fakeViewer(), { port: 5173 });
    await host.run(ctx.runId, 5173);
    probe.mockImplementationOnce(async () => {
      await host.run(ctx.runId, 5173);
      return false;
    });
    expect(await host.stopPreview(ctx.runId, { port: 5173, restart: true }))
      .toMatchObject({ ok: false, code: 'approval_required' });
    expect(devServers).toHaveLength(2);
    expect(devServers[1]!.stop).not.toHaveBeenCalled();
  });

  it('keeps a terminal owned process while another task holds the same port', async () => {
    const { host, ctx, devServers } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run(ctx.runId, 5173);
    await host.stop(ctx.runId, 5173, 'user');
    const other = { ...ctx, runId: 'run-2' };
    await host.open(other, fakeViewer(), { port: 5173 });
    await host.run(other.runId, 5173);
    await host.open(ctx, viewer, { port: 5173 });
    expect(viewer.messages.at(-1)).toMatchObject({ stage: 'port-held' });
    await host.stop(other.runId, 5173, 'user');
    expect(await host.stopPreview(ctx.runId, { port: 5173, restart: true })).toMatchObject({ code: 'restarted' });
    expect(devServers).toHaveLength(3);
  });

  it('does not start commands or replace their owner while server teardown is pending', async () => {
    const { host, ctx, devServers } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run(ctx.runId, 5173);
    let finish!: () => void;
    devServers[0]!.stop.mockImplementationOnce(async () => {
      devServers[0]!.set('stopped');
      await new Promise<void>(resolve => { finish = resolve; });
    });
    const stopping = host.stop(ctx.runId, 5173, 'user');
    await host.open(ctx, viewer, { port: 5173 });
    expect(viewer.messages.at(-1)).toMatchObject({ stage: 'server-stopped' });
    await host.run(ctx.runId, 5173);
    expect(devServers).toHaveLength(1);
    finish();
    await stopping;
  });

  it('an open probe that overlaps stop reports the owned process instead of adopting', async () => {
    const { host, ctx, devServers, probe } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run(ctx.runId, 5173);
    await host.stop(ctx.runId, 5173, 'user');
    let finishProbe!: (answer: boolean) => void;
    probe.mockImplementationOnce(() => new Promise<boolean>(resolve => { finishProbe = resolve; }));
    const opening = host.open(ctx, viewer, { port: 5173 });
    let finishStop!: () => void;
    devServers[0]!.stop.mockImplementationOnce(() => new Promise<void>(resolve => { finishStop = resolve; }));
    const stopping = host.stopPreview(ctx.runId, { port: 5173 });
    finishProbe(true);
    await opening;
    expect(viewer.messages.at(-1)).toMatchObject({ stage: 'server-stopped' });
    finishStop();
    await stopping;
    expect(await host.stopPreview(ctx.runId, { port: 5173 })).toMatchObject({ code: 'stopped' });
  });

  it('forgets a vanished adoption and reports that it had been running', async () => {
    const { host, ctx, answering } = make();
    const viewer = fakeViewer();
    answering.add(5173);
    await host.open(ctx, viewer, { port: 5173 });
    answering.clear();
    await host.open(ctx, viewer, { port: 5173 });
    expect(viewer.messages.at(-1)).toMatchObject({ stage: 'needs-approval', wasRunning: true });
    expect(await host.stopPreview(ctx.runId, { port: 5173 })).toMatchObject({ code: 'approval_required' });
    await host.open(ctx, viewer, { port: 5173 });
    expect(viewer.messages.at(-1)).toMatchObject({ stage: 'needs-approval', wasRunning: false });
  });

  it('re-registration without a viewer or matching pane never overwrites another port state', async () => {
    const { host, ctx, store, devServers } = make([server(5173), server(3000)]);
    await host.replaced('absent', 5173);
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.run(ctx.runId, 5173);
    await host.open(ctx, viewer, { port: 3000 });
    const last = viewer.messages.at(-1);
    store.getRun(ctx.runId)!.previewServers = [server(5173, { command: 'changed' }), server(3000)];
    await host.replaced(ctx.runId, 5173);
    expect(viewer.messages.at(-1)).toEqual(last);
    host.detach(ctx.runId, viewer);
    await host.replaced(ctx.runId, 3000);
    expect(viewer.messages.at(-1)).toEqual(last);
    expect(devServers[0]!.stop).toHaveBeenCalledWith('release');
    await flush();
  });
});
