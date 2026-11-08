import { expect, it, vi } from 'vitest';
import { useHostFixture, flush } from './host.testkit.ts';
import { fakeViewer } from './preview.testkit.ts';
import { PreviewSession } from './session.ts';

const make = useHostFixture();

it('passes the open ratio to both a new session and the session reused on reload', async () => {
  const { host, ctx, answering } = make();
  answering.add(5173);
  const attach = vi.spyOn(PreviewSession.prototype, 'attach');
  try {
    const first = fakeViewer();
    await host.handle(ctx, first, { t: 'open', target: { port: 5173 }, quality: 'ultra', dpr: 2 });
    await flush();
    expect(attach).toHaveBeenLastCalledWith(first, 2);
    host.detach(ctx.runId, first);
    attach.mockClear();
    const next = fakeViewer();
    await host.handle(ctx, next, { t: 'open', target: { port: 5173 }, quality: 'ultra', dpr: 1 });
    await flush();
    expect(attach.mock.calls.length).toBeGreaterThan(0);
    for (const call of attach.mock.calls) expect(call).toEqual([next, 1]);
  } finally {
    attach.mockRestore();
  }
});

it.each([1, 2, undefined])('same-viewer open with ratio %s restarts only for a changed ratio', async dpr => {
  const { host, ctx, answering, browsers } = make();
  answering.add(5173);
  const viewer = fakeViewer();
  await host.handle(ctx, viewer, { t: 'open', target: { port: 5173 }, quality: 'ultra', dpr: 2 });
  await flush();
  const browser = browsers[0]!;
  const before = browser.cdpFake.sent('Page.startScreencast').length;
  // A typed URL reuses the same page without reattaching the viewer.
  await host.handle(ctx, viewer, { t: 'open', target: { url: 'http://localhost:5173/next' }, quality: 'ultra', ...(dpr === undefined ? {} : { dpr }) });
  await flush();
  expect(browser.cdpFake.sent('Page.startScreencast')).toHaveLength(before + (dpr === 1 ? 1 : 0));
});
