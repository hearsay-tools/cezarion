import { describe, expect, it, vi } from 'vitest';
import { ChromiumError } from './chromium.ts';
import { ChromiumMissingError, PREVIEW_BROWSER_IDLE_MS } from './host.ts';
import { fakeAgentClient, fakeViewer } from './preview.testkit.ts';
import { flush, useHostFixture } from './host.testkit.ts';

describe('PreviewHost browser lifecycle', () => {
  const make = useHostFixture();

  it.each([{ url: 'http://localhost:3000/' }, { port: 3000 }])('streams a non-adopted page for target %j', async target => {
    const { host, ctx, browsers } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, target);
    expect(viewer.messages.filter(m => m.t === 'state')).toEqual([
      { t: 'state', stage: 'loading', step: 'browser' },
      { t: 'state', stage: 'loading', step: 'page' },
      { t: 'state', stage: 'loading', step: 'frame' },
    ]);
    browsers[0]!.cdpFake.emit('Page.screencastFrame', { data: 'AA==', sessionId: 1 });
    expect(viewer.messages.at(-1)).toEqual({ t: 'state', stage: 'streaming', adopted: false });
  });

  it.each([
    { error: new ChromiumError('exited', 'stderr', 'launch failed', { signal: 'SIGTERM' }), extra: { signal: 'SIGTERM' }, stderrTail: 'launch failed\nstderr' },
    { error: new ChromiumError('exited', '', 'launch failed'), extra: {}, stderrTail: 'launch failed' },
    { error: new Error('spawn refused'), extra: {}, stderrTail: 'spawn refused' },
    { error: 'spawn refused', extra: {}, stderrTail: 'spawn refused' },
  ])('reports exact browser failure fields: $stderrTail', async ({ error, extra, stderrTail }) => {
    const { host, ctx } = make(undefined, undefined, undefined, { launchBrowser: vi.fn().mockRejectedValue(error) });
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { url: 'http://localhost:3000/' });
    expect(viewer.messages.at(-1)).toEqual({ t: 'state', stage: 'browser-exited', reason: 'exited', stderrTail, serverUp: false, ...extra });
  });

  it('offers a download on a supported architecture', async () => {
    const { host, ctx } = make(undefined, () => new ChromiumMissingError(), undefined, { arch: 'x64' });
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { url: 'http://localhost:3000/' });
    expect(viewer.messages.at(-1)).toMatchObject({ stage: 'chromium-missing', canDownload: true });
  });

  it('retry after an agent launch failure can start a browser without a saved URL', async () => {
    let failure: Error | undefined = new Error('launch refused');
    const { host, ctx, browsers } = make(undefined, () => failure);
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { agent: true });
    const grant = host.grantAgent(ctx.runId, () => ctx);
    await host.connectAgent(grant.token, fakeAgentClient());
    failure = undefined;
    await host.handle(ctx, viewer, { t: 'retryBrowser' });
    expect(browsers).toHaveLength(1);
    expect(browsers[0]!.cdpFake.sent('Page.navigate')).toEqual([]);
    expect(host.ownsBrowser(ctx.runId)).toBe(true);
  });

  it('a browser that finishes launching after the idle deadline is closed instead of attached', async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const { host, ctx, browsers } = make(undefined, undefined, () => gate);
    const viewer = fakeViewer();
    const opening = host.open(ctx, viewer, { url: 'http://localhost:3000/' });
    host.detach(ctx.runId, viewer);
    await vi.advanceTimersByTimeAsync(PREVIEW_BROWSER_IDLE_MS);
    finish();
    await opening;
    expect(browsers[0]!.close).toHaveBeenCalledTimes(1);
    expect(browsers[0]!.cdpFake.cdp.close).toHaveBeenCalledTimes(1);
    expect(browsers[0]!.cdpFake.sent('Page.navigate')).toEqual([]);
    expect(host.ownsBrowser(ctx.runId)).toBe(false);
  });

  it('an old browser exit does not close a newer browser or replace its pane state', async () => {
    const { host, ctx, browsers } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { url: 'http://localhost:3000/' });
    host.detach(ctx.runId, viewer);
    await vi.advanceTimersByTimeAsync(PREVIEW_BROWSER_IDLE_MS);
    await host.open(ctx, viewer, { url: 'http://localhost:3000/' });
    const messages = [...viewer.messages];
    browsers[0]!.exit({ stderrTail: 'old crash' });
    await flush();
    expect(viewer.messages).toEqual(messages);
    expect(host.ownsBrowser(ctx.runId)).toBe(true);
    expect(browsers[1]!.close).not.toHaveBeenCalled();
  });

  it('an agent revoked during launch receives an unavailable refusal and leaves idle cleanup armed', async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const { host, ctx, browsers } = make(undefined, undefined, () => gate);
    const grant = host.grantAgent(ctx.runId, () => ctx);
    const pending = host.connectAgent(grant.token, fakeAgentClient());
    grant.revoke();
    finish();
    expect(await pending).toEqual({ refused: 'The preview browser is not available' });
    await vi.advanceTimersByTimeAsync(PREVIEW_BROWSER_IDLE_MS);
    expect(browsers[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('shutdown closes the pane with its public close reason', async () => {
    const { host, ctx } = make();
    const viewer = fakeViewer();
    await host.open(ctx, viewer, { port: 5173 });
    await host.close();
    expect(viewer.closed).toEqual([{ code: 1001, reason: 'cezar is shutting down' }]);
  });
});
