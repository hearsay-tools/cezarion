import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeCdp, fakeViewer } from './preview.testkit.ts';
import { PreviewSession } from './session.ts';

const frame = (text: string, sessionId: number) => ({ data: Buffer.from(text).toString('base64'), sessionId });
/** A JPEG header the size of `w` x `h`: SOI, then a baseline SOF0 segment. Enough for the session to read dimensions. */
const jpeg = (w: number, h: number) =>
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]).toString('base64');
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

  it('serializes viewport changes: stop and start never interleave, a repeated size does not restart', async () => {
    // The pane sends a resize at every loading step. Overlapping restarts left Chromium with no
    // first frame on a static page, so the pane sat on "First frame" for good (#781 e2e).
    const { cdp, sent, calls } = fakeCdp();
    const session = await PreviewSession.create(cdp);
    const first = fakeViewer();
    session.attach(first);
    await Promise.all([1, 2, 3].map(() => session.handle({ t: 'resize', w: 646, h: 787 })));
    await flush();
    const screencast = calls.map(call => call.method).filter(method => method === 'Page.stopScreencast' || method === 'Page.startScreencast');
    expect(screencast).toEqual(['Page.stopScreencast', 'Page.startScreencast', 'Page.stopScreencast', 'Page.startScreencast']);
    expect(sent('Page.startScreencast').map(call => [call.params.maxWidth, call.params.maxHeight])).toEqual([[1280, 800], [646, 787]]);

    // A new viewer always restarts the stream, even at the size it already has: it needs its own first frame.
    session.detach(first);
    session.attach(fakeViewer());
    await flush();
    expect(sent('Page.startScreencast').map(call => [call.params.maxWidth, call.params.maxHeight])).toEqual([[1280, 800], [646, 787], [646, 787]]);
  });

  describe('first-frame watchdog', () => {
    afterEach(() => vi.useRealTimers());

    it('restarts a stream that produced no frame, until one arrives', async () => {
      // Back-to-back restarts can leave Chromium silent on a page that no longer changes, so a
      // start with no frame after it is retried (#781 e2e: the pane stuck on "First frame").
      vi.useFakeTimers();
      const { cdp, sent, emit } = fakeCdp();
      const session = await PreviewSession.create(cdp);
      session.attach(fakeViewer());
      await vi.advanceTimersByTimeAsync(0);
      expect(sent('Page.startScreencast')).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(500);
      expect(sent('Page.startScreencast')).toHaveLength(2);
      expect(sent('Page.stopScreencast')).toHaveLength(2);

      emit('Page.screencastFrame', frame('A', 2));
      await vi.advanceTimersByTimeAsync(5000);
      expect(sent('Page.startScreencast')).toHaveLength(2);
    });

    it('gives up after a few tries and stops when the viewer leaves', async () => {
      vi.useFakeTimers();
      const { cdp, sent } = fakeCdp();
      const session = await PreviewSession.create(cdp);
      const viewer = fakeViewer();
      session.attach(viewer);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent('Page.startScreencast')).toHaveLength(6);

      const second = fakeViewer();
      session.attach(second);
      await vi.advanceTimersByTimeAsync(0);
      session.detach(second);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent('Page.startScreencast')).toHaveLength(7);
    });
  });

  describe('frame size check', () => {
    afterEach(() => vi.useRealTimers());

    it('restarts a stream whose frame is not the viewport size, until one is', async () => {
      // Chromium can capture the first frame while the page is still at its old size (a 646x362
      // frame for a 646x787 viewport) and send no other on a page that no longer changes. A click
      // maps to page pixels only at the viewport size, so that frame must be replaced (#781 e2e).
      vi.useFakeTimers();
      const { cdp, sent, emit } = fakeCdp();
      const session = await PreviewSession.create(cdp);
      const viewer = fakeViewer();
      session.attach(viewer);
      await session.handle({ t: 'resize', w: 646, h: 787 });
      await vi.advanceTimersByTimeAsync(0);
      const starts = sent('Page.startScreencast').length;

      emit('Page.screencastFrame', { data: jpeg(646, 362), sessionId: 2 });
      expect(viewer.frames).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(500);
      expect(sent('Page.startScreencast')).toHaveLength(starts + 1);
      expect(sent('Page.startScreencast').at(-1)?.params).toMatchObject({ maxWidth: 646, maxHeight: 787 });

      emit('Page.screencastFrame', { data: jpeg(646, 787), sessionId: 3 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(sent('Page.startScreencast')).toHaveLength(starts + 1);
    });

    it('stops retrying a size Chromium never delivers', async () => {
      vi.useFakeTimers();
      const { cdp, sent, emit } = fakeCdp();
      const session = await PreviewSession.create(cdp);
      session.attach(fakeViewer());
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 12; i += 1) {
        emit('Page.screencastFrame', { data: jpeg(300, 200), sessionId: i + 1 });
        await vi.advanceTimersByTimeAsync(600);
      }
      expect(sent('Page.startScreencast')).toHaveLength(6);
    });

    it('takes a frame whose size it cannot read as the right one', async () => {
      vi.useFakeTimers();
      const { cdp, sent, emit } = fakeCdp();
      const session = await PreviewSession.create(cdp);
      session.attach(fakeViewer());
      await vi.advanceTimersByTimeAsync(0);
      emit('Page.screencastFrame', frame('not a jpeg', 1));
      await vi.advanceTimersByTimeAsync(5000);
      expect(sent('Page.startScreencast')).toHaveLength(1);
    });
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
