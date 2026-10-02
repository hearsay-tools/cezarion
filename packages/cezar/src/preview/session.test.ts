import { describe, expect, it } from 'vitest';
import { fakeCdp, fakeViewer } from './preview.testkit.ts';
import { PreviewSession } from './session.ts';

const frame = (text: string, sessionId: number) => ({ data: Buffer.from(text).toString('base64'), sessionId });
const flush = () => new Promise(resolve => setImmediate(resolve));

describe('PreviewSession', () => {
  it('prepares the page like the prototype: cursor binding and the injected script', async () => {
    const { cdp, sent } = fakeCdp();
    await PreviewSession.create(cdp);
    expect(sent('Runtime.addBinding')[0]?.params).toEqual({ name: '__cursor' });
    expect(String(sent('Page.addScriptToEvaluateOnNewDocument')[0]?.params.source)).toContain('window.__cursor');
  });

  it('keeps one frame in flight and sends only the newest after an ack', async () => {
    const { cdp, emit, sent } = fakeCdp();
    const session = await PreviewSession.create(cdp);
    const viewer = fakeViewer();
    session.attach(viewer);
    await flush();
    expect(sent('Page.startScreencast')).toHaveLength(1);

    emit('Page.screencastFrame', frame('A', 1));
    emit('Page.screencastFrame', frame('B', 2));
    emit('Page.screencastFrame', frame('C', 3));
    expect(viewer.frames).toEqual(['A']);
    // B was replaced while held: Chromium gets its ack so it keeps producing frames.
    expect(sent('Page.screencastFrameAck').map(call => call.params.sessionId)).toEqual([2]);

    await session.handle({ t: 'ack' });
    expect(sent('Page.screencastFrameAck').map(call => call.params.sessionId)).toEqual([2, 1]);
    expect(viewer.frames).toEqual(['A', 'C']);
  });

  it('acks frames nobody watches', async () => {
    const { cdp, emit, sent } = fakeCdp();
    await PreviewSession.create(cdp);
    emit('Page.screencastFrame', frame('A', 7));
    expect(sent('Page.screencastFrameAck').map(call => call.params.sessionId)).toEqual([7]);
  });

  it('reload { ignoreCache: true } calls Page.reload with ignoreCache', async () => {
    const { cdp, sent } = fakeCdp();
    const session = await PreviewSession.create(cdp);
    session.attach(fakeViewer());
    await session.handle({ t: 'reload', ignoreCache: true });
    await session.handle({ t: 'reload' });
    expect(sent('Page.reload').map(call => call.params)).toEqual([{ ignoreCache: true }, { ignoreCache: false }]);
  });

  it('forwards a page dialog with the origin of the frame that opened it', async () => {
    const { cdp, emit } = fakeCdp();
    const session = await PreviewSession.create(cdp);
    const viewer = fakeViewer();
    session.attach(viewer);
    emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete it?', url: 'http://localhost:5173/items/4', hasBrowserHandler: true });
    expect(viewer.messages).toContainEqual({ t: 'dialog', type: 'confirm', message: 'Delete it?', origin: 'http://localhost:5173' });
  });

  it('maps input to CDP and refuses a non-http navigation', async () => {
    const { cdp, sent } = fakeCdp();
    const session = await PreviewSession.create(cdp);
    session.attach(fakeViewer());
    await session.handle({ t: 'mouse', type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 });
    expect(sent('Input.dispatchMouseEvent')[0]?.params).toMatchObject({ type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 });
    await session.handle({ t: 'back' });
    expect(sent('Page.navigateToHistoryEntry')[0]?.params).toEqual({ entryId: 10 });
    await expect(session.handle({ t: 'nav', url: 'javascript:alert(1)' })).rejects.toThrow('only http(s)');
    await session.handle({ t: 'nav', url: '5173' });
    expect(sent('Page.navigate').at(-1)?.params).toEqual({ url: 'http://localhost:5173/' });
  });

  it('reports the URL and cursor shape to the viewer', async () => {
    const { cdp, emit } = fakeCdp();
    const session = await PreviewSession.create(cdp);
    const viewer = fakeViewer();
    session.attach(viewer);
    emit('Page.frameNavigated', { frame: { id: 'main', url: 'http://localhost:5173/' } });
    emit('Page.frameNavigated', { frame: { id: 'ad', parentId: 'main', url: 'http://ads.example/' } });
    emit('Runtime.bindingCalled', { name: '__cursor', payload: 'pointer' });
    expect(viewer.messages).toEqual([{ t: 'url', url: 'http://localhost:5173/' }, { t: 'cursor', cursor: 'pointer' }]);
    expect(session.url).toBe('http://localhost:5173/');
  });

  it('calls onFirstFrame once per attached viewer, before that viewer\'s first frame', async () => {
    const { cdp, emit } = fakeCdp();
    const seen: string[] = [];
    const session = await PreviewSession.create(cdp, { onFirstFrame: viewer => seen.push(`${viewer.userAgent}:${(viewer as ReturnType<typeof fakeViewer>).frames.length}`) });
    const first = fakeViewer('A');
    session.attach(first);
    emit('Page.screencastFrame', frame('1', 1));
    await session.handle({ t: 'ack' });
    emit('Page.screencastFrame', frame('2', 2));
    session.detach(first);
    session.attach(fakeViewer('B'));
    emit('Page.screencastFrame', frame('3', 3));
    expect(seen).toEqual(['A:0', 'B:0']);
  });
});
