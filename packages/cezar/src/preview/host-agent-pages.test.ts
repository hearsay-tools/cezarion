import { describe, expect, it, vi } from 'vitest';
import { fakeAgentClient, fakeViewer } from './preview.testkit.ts';
import { flush, navigations, useHostFixture } from './host.testkit.ts';
import type { CdpMessage } from './cdp.ts';

describe('PreviewHost agent pages', () => {
  const make = useHostFixture();
  async function preview() {
    const env = make();
    const viewer = fakeViewer();
    await env.host.open(env.ctx, viewer, { url: 'http://localhost:5173/' });
    const grant = env.host.grantAgent(env.ctx.runId, () => env.ctx);
    const client = fakeAgentClient();
    const link = await env.host.connectAgent(grant.token, client);
    if ('refused' in link) throw new Error(link.refused);
    await env.host.open(env.ctx, viewer, { agent: true });
    const browser = env.browsers[0]!;
    const activate = async (targetId: string) => {
      link.fromClient(JSON.stringify({ id: 1, method: 'Target.activateTarget', params: { targetId } }));
      await flush();
    };
    return { ...env, viewer, link, grant, browser, conn: browser.connectionFake, activate };
  }

  it('announces streaming and sends frames from the followed page as non-adopted', async () => {
    const { viewer, conn, activate } = await preview();
    await activate('A');
    conn.pages.get('S1')!.emit('Page.screencastFrame', { data: 'aGVsbG8=', sessionId: 9 });
    expect(viewer.messages.at(-1)).toEqual({ t: 'state', stage: 'streaming', adopted: false });
    expect(viewer.frames).toEqual(['hello']);
  });

  it('switches between agent pages, closes the old session and restores the home page', async () => {
    const { host, ctx, viewer, browser, conn, activate } = await preview();
    await activate('A');
    await activate('B');
    expect(conn.pages.get('S1')!.cdp.close).toHaveBeenCalledTimes(1);
    conn.emit({ method: 'Target.detachedFromTarget', params: { sessionId: 'S1' } });
    expect(conn.pages.get('S2')!.cdp.close).not.toHaveBeenCalled();
    conn.emit({ method: 'Target.detachedFromTarget', params: { sessionId: 'S2' } });
    await host.open(ctx, viewer, { agent: true });
    await flush();
    expect(conn.requests.filter(r => r.method === 'Target.attachToTarget')).toHaveLength(2);
    expect(conn.pages.get('S2')!.cdp.close).toHaveBeenCalledTimes(1);
    expect(browser.cdpFake.sent('Page.startScreencast').length).toBeGreaterThan(0);
  });

  it('returns from an agent page to the protected home target without attaching a new session', async () => {
    const { conn, browser, activate } = await preview();
    await activate('A');
    await activate('PANE');
    expect(conn.pages.get('S1')!.cdp.close).toHaveBeenCalledTimes(1);
    expect(conn.requests.filter(r => r.method === 'Target.attachToTarget')).toHaveLength(1);
    expect(navigations(browser)).toEqual(['http://localhost:5173/']);
  });

  it.each([undefined, {}, { targetInfo: {} }, { targetInfo: { url: 42 } }, { targetInfo: { url: '' } }])('does not send a URL when page URL metadata is absent or invalid: %j', async result => {
    const { browser, viewer, activate } = await preview();
    const call = browser.connection.call.bind(browser.connection);
    let infoCalls = 0;
    vi.spyOn(browser.connection, 'call').mockImplementation((method, params, sessionId) => {
      if (method === 'Target.getTargetInfo' && ++infoCalls === 2) return Promise.resolve({ result });
      return call(method, params, sessionId);
    });
    await activate('A');
    expect(viewer.messages.filter(m => m.t === 'url')).toEqual([]);
  });

  it.each([undefined, {}, { targetInfo: {} }])('ignores targets with missing type metadata: %j', async result => {
    const { browser, conn, activate } = await preview();
    vi.spyOn(browser.connection, 'call').mockResolvedValueOnce({ result });
    await activate('A');
    expect(conn.requests.filter(r => r.method === 'Target.attachToTarget')).toEqual([]);
  });

  it.each(['url', 'release', 'new-target', 'duplicate'] as const)('closes a page session whose attachment loses to %s', async change => {
    const { host, ctx, viewer, browser, conn, activate } = await preview();
    const original = browser.connection.call.bind(browser.connection);
    let finish!: (reply: CdpMessage) => void;
    const spy = vi.spyOn(browser.connection, 'call');
    spy.mockImplementation((method, params, sessionId) => {
      if (method === 'Target.attachToTarget' && !finish) return new Promise<CdpMessage>(resolve => { finish = resolve; });
      return original(method, params, sessionId);
    });
    await activate('A');
    if (change === 'url') await host.open(ctx, viewer, { url: 'http://localhost:3000/' });
    else if (change === 'release') await host.release(ctx.runId);
    else await activate(change === 'duplicate' ? 'A' : 'B');
    finish({ result: { sessionId: 'LATE' } });
    await flush();
    expect(conn.pages.get('LATE')!.cdp.close).toHaveBeenCalledTimes(1);
    expect(conn.pages.get('LATE')!.sent('Page.startScreencast')).toEqual([]);
  });
});
