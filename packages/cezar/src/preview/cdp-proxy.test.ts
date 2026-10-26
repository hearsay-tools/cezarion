import { describe, expect, it } from 'vitest';
import type { CdpConnection, CdpMessage } from './cdp.ts';
import { AgentCdpLink, type AgentClient } from './cdp-proxy.ts';

/** A browser connection the test answers by hand: every request waits in `requests` until replied. */
function fakeConnection() {
  const requests: Array<{ method: string; params: unknown; sessionId: string | undefined; reply(msg: CdpMessage): void }> = [];
  const eventFns = new Set<(msg: CdpMessage) => void>();
  let markClosed!: () => void;
  const closed = new Promise<void>(resolve => (markClosed = resolve));
  const request: CdpConnection['request'] = (method, params, sessionId, onReply) => {
    // The browser session is granted at once; everything else waits for the test.
    if (method === 'Target.attachToBrowserTarget') return onReply({ result: { sessionId: 'B1' } });
    requests.push({ method, params, sessionId, reply: onReply });
  };
  const connection: CdpConnection = {
    request,
    call: (method, params, sessionId) => new Promise(resolve => request(method, params, sessionId, resolve)),
    onEvent: fn => {
      eventFns.add(fn);
      return () => void eventFns.delete(fn);
    },
    session: () => { throw new Error('not used'); },
    close: () => markClosed(),
    closed,
  };
  return { connection, requests, emit: (msg: CdpMessage) => { for (const fn of [...eventFns]) fn(msg); }, endBrowser: markClosed };
}

function fakeClient() {
  const sent: CdpMessage[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const client: AgentClient = { send: text => sent.push(JSON.parse(text)), close: (code, reason) => closes.push({ code, reason }) };
  return { client, sent, closes };
}

async function linked(opts: { protectedTargetId?: string } = {}) {
  const browser = fakeConnection();
  const agent = fakeClient();
  let closedLinks = 0;
  const link = await AgentCdpLink.open(browser.connection, agent.client, { ...opts, onClose: () => (closedLinks += 1) });
  return { browser, agent, link, closedLinks: () => closedLinks };
}

describe('AgentCdpLink (hearsay-tools/cezarion#784)', () => {
  it("sends the agent's root commands to its own browser session and answers without a sessionId", async () => {
    const { browser, agent, link } = await linked();
    link.fromClient(JSON.stringify({ id: 7, method: 'Target.getTargets', params: {} }));
    expect(browser.requests).toMatchObject([{ method: 'Target.getTargets', sessionId: 'B1' }]);
    browser.requests[0]!.reply({ id: 1, result: { targetInfos: [] }, sessionId: 'B1' });
    expect(agent.sent).toEqual([{ id: 7, result: { targetInfos: [] } }]);
  });

  it('passes a session the agent attached to, and echoes that session on the reply', async () => {
    const { browser, agent, link } = await linked();
    link.fromClient(JSON.stringify({ id: 1, method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } }));
    browser.requests[0]!.reply({ id: 1, result: { sessionId: 'C1' }, sessionId: 'B1' });
    link.fromClient(JSON.stringify({ id: 2, method: 'Page.navigate', params: { url: 'http://localhost:5173/' }, sessionId: 'C1' }));
    expect(browser.requests[1]).toMatchObject({ method: 'Page.navigate', params: { url: 'http://localhost:5173/' }, sessionId: 'C1' });
    browser.requests[1]!.reply({ id: 2, result: { frameId: 'F' }, sessionId: 'C1' });
    expect(agent.sent).toEqual([{ id: 1, result: { sessionId: 'C1' } }, { id: 2, result: { frameId: 'F' }, sessionId: 'C1' }]);
  });

  it("refuses a session it did not open, such as cezar's own page session, without asking the browser", async () => {
    const { browser, agent, link } = await linked();
    link.fromClient(JSON.stringify({ id: 3, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: 'CEZAR-PAGE' }));
    link.fromClient(JSON.stringify({ id: 4, method: 'Target.detachFromTarget', params: { sessionId: 'CEZAR-PAGE' } }));
    expect(browser.requests).toEqual([]);
    expect(agent.sent).toEqual([
      { id: 3, error: { code: -32000, message: 'Session with given id not found.' }, sessionId: 'CEZAR-PAGE' },
      { id: 4, error: { code: -32000, message: 'Session with given id not found.' } },
    ]);
  });

  it.each(['Browser.close', 'Browser.crash', 'Browser.crashGpuProcess'])('refuses %s, which would end the browser the owner watches', async method => {
    const { browser, agent, link } = await linked();
    link.fromClient(JSON.stringify({ id: 5, method }));
    expect(browser.requests).toEqual([]);
    expect(agent.sent).toEqual([{ id: 5, error: { code: -32000, message: `cezar refuses ${method}: the owner's preview pane shares this browser.` } }]);
  });

  it("refuses closing the page the pane streams, by target and by its session, and allows the agent's other tabs", async () => {
    const { browser, agent, link } = await linked({ protectedTargetId: 'PANE' });
    link.fromClient(JSON.stringify({ id: 1, method: 'Target.closeTarget', params: { targetId: 'PANE' } }));
    link.fromClient(JSON.stringify({ id: 2, method: 'Target.attachToTarget', params: { targetId: 'PANE', flatten: true } }));
    browser.requests[0]!.reply({ id: 9, result: { sessionId: 'C1' }, sessionId: 'B1' });
    link.fromClient(JSON.stringify({ id: 3, method: 'Page.close', sessionId: 'C1' }));
    link.fromClient(JSON.stringify({ id: 4, method: 'Target.closeTarget', params: { targetId: 'OTHER' } }));
    expect(browser.requests.map(r => r.method)).toEqual(['Target.attachToTarget', 'Target.closeTarget']);
    expect(agent.sent.filter(m => m.error).map(m => m.id)).toEqual([1, 3]);
  });

  it('delivers events in wire order: its browser session without a sessionId, children as they came, nothing else', async () => {
    const { browser, agent } = await linked();
    browser.emit({ method: 'Target.attachedToTarget', params: { sessionId: 'C2', targetInfo: { targetId: 'T2' } }, sessionId: 'B1' });
    browser.emit({ method: 'Page.frameNavigated', params: { n: 1 }, sessionId: 'C2' });
    browser.emit({ method: 'Page.frameNavigated', params: { n: 2 }, sessionId: 'CEZAR-PAGE' });
    browser.emit({ method: 'Target.targetCreated', params: { n: 3 } });
    browser.emit({ method: 'Target.detachedFromTarget', params: { sessionId: 'C2' }, sessionId: 'B1' });
    browser.emit({ method: 'Page.frameNavigated', params: { n: 4 }, sessionId: 'C2' });
    expect(agent.sent).toEqual([
      { method: 'Target.attachedToTarget', params: { sessionId: 'C2', targetInfo: { targetId: 'T2' } } },
      { method: 'Page.frameNavigated', params: { n: 1 }, sessionId: 'C2' },
      { method: 'Target.detachedFromTarget', params: { sessionId: 'C2' } },
    ]);
  });

  it('answers a browser error as the browser sent it', async () => {
    const { browser, agent, link } = await linked();
    link.fromClient(JSON.stringify({ id: 6, method: 'Page.navigate', params: { url: 'bad' } }));
    browser.requests[0]!.reply({ id: 1, error: { code: -32602, message: 'Invalid URL' }, sessionId: 'B1' });
    expect(agent.sent).toEqual([{ id: 6, error: { code: -32602, message: 'Invalid URL' } }]);
  });

  it('ignores a message that is not a command', async () => {
    const { browser, agent, link } = await linked();
    link.fromClient('not json');
    link.fromClient(JSON.stringify({ method: 'Page.enable' }));
    link.fromClient(JSON.stringify({ id: 'x', method: 'Page.enable' }));
    expect(browser.requests).toEqual([]);
    expect(agent.sent).toEqual([]);
  });

  it('detaches its browser session once on close, and tells its owner', async () => {
    const { browser, agent, link, closedLinks } = await linked();
    link.close(1000, 'bye');
    link.close(1000, 'again');
    expect(browser.requests).toMatchObject([{ method: 'Target.detachFromTarget', params: { sessionId: 'B1' }, sessionId: undefined }]);
    expect(agent.closes).toEqual([{ code: 1000, reason: 'bye' }]);
    expect(closedLinks()).toBe(1);
    link.fromClient(JSON.stringify({ id: 1, method: 'Page.enable' }));
    browser.emit({ method: 'Page.loadEventFired', params: {}, sessionId: 'B1' });
    expect(agent.sent).toEqual([]);
  });

  it('closes the agent socket with 1011 when the browser goes', async () => {
    const { browser, agent, closedLinks } = await linked();
    browser.endBrowser();
    await browser.connection.closed;
    await Promise.resolve();
    expect(agent.closes).toEqual([{ code: 1011, reason: 'The preview browser exited' }]);
    expect(closedLinks()).toBe(1);
  });

  it('rejects open when the browser refuses a browser session', async () => {
    const browser = fakeConnection();
    browser.connection.call = async () => ({ error: { message: 'Not supported' } });
    await expect(AgentCdpLink.open(browser.connection, fakeClient().client)).rejects.toThrow('Target.attachToBrowserTarget: Not supported');
  });
});
