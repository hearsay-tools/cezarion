import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeCdp, fakeViewer } from './preview.testkit.ts';
import type { PreviewQuality } from '@open-mercato/cezar-contract';
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

  describe('stream quality (hearsay-tools/cezarion#2066)', () => {
    afterEach(() => vi.useRealTimers());

    const qualities = (sent: ReturnType<typeof fakeCdp>['sent']) => sent('Page.startScreencast').map(call => call.params.quality);

    it('streams Normal at JPEG quality 60 when nobody chose a mode', async () => {
      const { cdp, sent } = fakeCdp();
      const session = await PreviewSession.create(cdp);
      session.attach(fakeViewer());
      await flush();
      expect(sent('Page.startScreencast')[0]?.params).toEqual({ format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
    });

    it('streams High at JPEG quality 100, at the same size and with the same device scale factor', async () => {
      const { cdp, sent } = fakeCdp();
      const session = await PreviewSession.create(cdp, { quality: () => 'high' });
      session.attach(fakeViewer());
      await flush();
      expect(sent('Page.startScreencast')[0]?.params).toEqual({ format: 'jpeg', quality: 100, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
      expect(sent('Emulation.setDeviceMetricsOverride')[0]?.params).toMatchObject({ deviceScaleFactor: 1 });
    });

    it('a mode change restarts only the screencast: no navigation, no reload, no new viewport', async () => {
      let quality: PreviewQuality = 'normal';
      const { cdp, sent, calls } = fakeCdp();
      const session = await PreviewSession.create(cdp, { quality: () => quality });
      session.attach(fakeViewer());
      await session.handle({ t: 'resize', w: 646, h: 787 });
      await flush();
      const before = calls.length;

      quality = 'high';
      await session.refreshQuality();
      const after = calls.slice(before).map(call => call.method);
      expect(after).toEqual(['Page.stopScreencast', 'Page.startScreencast']);
      expect(sent('Page.startScreencast').at(-1)?.params).toEqual({ format: 'jpeg', quality: 100, maxWidth: 646, maxHeight: 787, everyNthFrame: 1 });

      // The same mode again restarts nothing.
      await session.refreshQuality();
      expect(calls.length).toBe(before + 2);

      quality = 'normal';
      await session.refreshQuality();
      expect(qualities(sent).at(-1)).toBe(60);
    });

    it('drops the frame in flight on a mode change, so the next frame reaches the viewer', async () => {
      let quality: PreviewQuality = 'normal';
      const { cdp, emit } = fakeCdp();
      const session = await PreviewSession.create(cdp, { quality: () => quality });
      const viewer = fakeViewer();
      session.attach(viewer);
      await flush();
      emit('Page.screencastFrame', frame('normal', 1));
      quality = 'high';
      await session.refreshQuality();
      emit('Page.screencastFrame', frame('high', 1));
      expect(viewer.frames).toEqual(['normal', 'high']);
    });

    it('keeps the chosen mode through a resize, a watchdog restart, page activity and a new viewer', async () => {
      vi.useFakeTimers();
      const { cdp, sent, emit } = fakeCdp();
      const session = await PreviewSession.create(cdp, { quality: () => 'high' });
      const first = fakeViewer();
      session.attach(first);
      await vi.advanceTimersByTimeAsync(0);
      await session.handle({ t: 'resize', w: 646, h: 787 });
      // No frame: the first-frame watchdog restarts the stream.
      await vi.advanceTimersByTimeAsync(500);
      emit('Page.screencastFrame', frame('A', 1));
      await session.handle({ t: 'ack' });
      // A click with no frame after it restarts the stream too.
      await session.handle({ t: 'mouse', type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 });
      await vi.advanceTimersByTimeAsync(1000);
      session.detach(first);
      session.attach(fakeViewer());
      await vi.advanceTimersByTimeAsync(0);
      expect(sent('Page.startScreencast').length).toBeGreaterThanOrEqual(5);
      expect(new Set(qualities(sent))).toEqual(new Set([100]));
    });

    it('a mode change with no viewer starts nothing; the next viewer gets the mode', async () => {
      let quality: PreviewQuality = 'normal';
      const { cdp, sent } = fakeCdp();
      const session = await PreviewSession.create(cdp, { quality: () => quality });
      quality = 'high';
      await session.refreshQuality();
      expect(sent('Page.startScreencast')).toHaveLength(0);
      session.attach(fakeViewer());
      await flush();
      expect(qualities(sent)).toEqual([100]);
    });
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

  describe('restart after page activity (#870)', () => {
    // Chromium can paint once and then send nothing more, so a change on screen never reaches the
    // pane. On mvp-unveiled task 76e2a345 the first paint came at about 11s, after the first-frame
    // retries had run out, and later clicks left the canvas on that frame.
    afterEach(() => vi.useRealTimers());

    /** A session whose stream started and painted once, then went quiet. */
    async function idleSession() {
      vi.useFakeTimers();
      const fake = fakeCdp();
      const session = await PreviewSession.create(fake.cdp);
      const viewer = fakeViewer();
      session.attach(viewer);
      await vi.advanceTimersByTimeAsync(0);
      fake.emit('Page.screencastFrame', frame('first', 1));
      await session.handle({ t: 'ack' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fake.sent('Page.startScreencast')).toHaveLength(1);
      return { ...fake, session, viewer };
    }

    it('turns on lifecycle events so a late paint can restart the stream', async () => {
      const { cdp, sent } = fakeCdp();
      await PreviewSession.create(cdp);
      expect(sent('Page.setLifecycleEventsEnabled')[0]?.params).toEqual({ enabled: true });
    });

    it('streams a first paint that comes after the first-frame retries ran out', async () => {
      vi.useFakeTimers();
      const { cdp, sent, emit } = fakeCdp();
      const session = await PreviewSession.create(cdp);
      const viewer = fakeViewer();
      session.attach(viewer);
      await vi.advanceTimersByTimeAsync(10_000);
      const starts = sent('Page.startScreencast').length;

      emit('Page.frameNavigated', { frame: { id: 'main', url: 'http://localhost:3825/en/events' } });
      emit('Page.lifecycleEvent', { frameId: 'main', name: 'firstContentfulPaint' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(sent('Page.startScreencast')).toHaveLength(starts + 1);
      emit('Page.screencastFrame', frame('late paint', 9));
      expect(viewer.frames).toEqual(['late paint']);
    });

    it('a late paint the wrong size is still replaced', async () => {
      vi.useFakeTimers();
      const { cdp, sent, emit } = fakeCdp();
      const session = await PreviewSession.create(cdp);
      session.attach(fakeViewer());
      await vi.advanceTimersByTimeAsync(10_000);
      const starts = sent('Page.startScreencast').length;

      emit('Page.lifecycleEvent', { frameId: 'main', name: 'firstContentfulPaint' });
      emit('Page.screencastFrame', { data: jpeg(800, 600), sessionId: 9 });
      await vi.advanceTimersByTimeAsync(500);
      expect(sent('Page.startScreencast')).toHaveLength(starts + 1);
    });

    it('a click after idle with no frame after it restarts the stream for a new one', async () => {
      const { session, sent, emit, viewer } = await idleSession();
      await session.handle({ t: 'mouse', type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 });
      await session.handle({ t: 'mouse', type: 'mouseReleased', x: 10, y: 20, button: 'left', clickCount: 1 });
      await vi.advanceTimersByTimeAsync(999);
      expect(sent('Page.startScreencast')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent('Page.startScreencast')).toHaveLength(2);
      emit('Page.screencastFrame', frame('after click', 1));
      expect(viewer.frames).toEqual(['first', 'after click']);
    });

    it('a full navigation after idle restarts the stream for a new frame', async () => {
      const { sent, emit, viewer } = await idleSession();
      emit('Page.frameNavigated', { frame: { id: 'main', url: 'http://localhost:3825/en/events?chat=1' } });
      emit('Page.lifecycleEvent', { frameId: 'main', name: 'load' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(sent('Page.startScreencast')).toHaveLength(2);
      emit('Page.screencastFrame', frame('after navigation', 1));
      expect(viewer.frames).toEqual(['first', 'after navigation']);
    });

    it('a start Chromium refused is retried at the next page activity (hearsay-tools/cezarion#784)', async () => {
      vi.useFakeTimers();
      const fake = fakeCdp();
      const send = fake.cdp.send;
      let refuse = true;
      fake.cdp.send = (async (method: string, params?: Record<string, unknown>) => {
        const reply = await send(method, params);
        if (method === 'Page.startScreencast' && refuse) {
          refuse = false;
          throw new Error('Page.startScreencast: Not attached to an active page');
        }
        return reply;
      }) as typeof send;
      const session = await PreviewSession.create(fake.cdp);
      const viewer = fakeViewer();
      session.attach(viewer);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fake.sent('Page.startScreencast')).toHaveLength(1);
      fake.emit('Page.frameNavigated', { frame: { id: 'main', url: 'http://localhost:3825/' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.sent('Page.startScreencast')).toHaveLength(2);
      fake.emit('Page.screencastFrame', frame('after commit', 1));
      expect(viewer.frames).toEqual(['after commit']);
    });

    it('an in-page navigation after idle restarts the stream for a new frame', async () => {
      const { sent, emit } = await idleSession();
      emit('Page.navigatedWithinDocument', { frameId: 'main', url: 'http://localhost:3825/en/events?chat=1' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(sent('Page.startScreencast')).toHaveLength(2);
    });

    it('does not restart when the page answers activity with a frame', async () => {
      const { session, sent, emit } = await idleSession();
      await session.handle({ t: 'key', type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' });
      emit('Page.screencastFrame', frame('typed', 2));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent('Page.startScreencast')).toHaveLength(1);
    });

    it('pointer moves and a subframe\'s load steps restart nothing', async () => {
      const { session, sent, emit } = await idleSession();
      emit('Page.frameNavigated', { frame: { id: 'main', url: 'http://localhost:3825/' } });
      await vi.advanceTimersByTimeAsync(10_000);
      const starts = sent('Page.startScreencast').length;
      await session.handle({ t: 'mouse', type: 'mouseMoved', x: 5, y: 5 });
      emit('Page.lifecycleEvent', { frameId: 'ad', name: 'load' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent('Page.startScreencast')).toHaveLength(starts);
    });

    it('gives each activity a few tries, then stops until the next one', async () => {
      const { session, sent } = await idleSession();
      await session.handle({ t: 'reload' });
      await vi.advanceTimersByTimeAsync(10_000);
      // The first start, then five tries for the reload: one after the activity wait, four at the first-frame pace.
      expect(sent('Page.startScreencast')).toHaveLength(6);
      await session.handle({ t: 'insertText', text: 'x' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent('Page.startScreencast')).toHaveLength(11);
    });

    it('still dispatches input while the pane holds the last frame unacked', async () => {
      vi.useFakeTimers();
      const { cdp, sent, emit } = fakeCdp();
      const session = await PreviewSession.create(cdp);
      session.attach(fakeViewer());
      await vi.advanceTimersByTimeAsync(0);
      emit('Page.screencastFrame', frame('last', 1));
      await session.handle({ t: 'mouse', type: 'mousePressed', x: 1, y: 2, button: 'left', clickCount: 1 });
      await session.handle({ t: 'key', type: 'keyDown', key: 'Enter', code: 'Enter' });
      expect(sent('Input.dispatchMouseEvent')).toHaveLength(1);
      expect(sent('Input.dispatchKeyEvent')).toHaveLength(1);
    });

    it('arms nothing without a viewer', async () => {
      vi.useFakeTimers();
      const { cdp, sent, emit } = fakeCdp();
      const session = await PreviewSession.create(cdp);
      await session.handle({ t: 'mouse', type: 'mousePressed', x: 1, y: 2, button: 'left', clickCount: 1 });
      emit('Page.lifecycleEvent', { frameId: 'main', name: 'load' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent('Page.startScreencast')).toHaveLength(0);
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

describe('preview session caller contract', () => {
  afterEach(() => vi.useRealTimers());

  it('enables the page and runtime before installing the cursor script', async () => {
    const { cdp, calls } = fakeCdp();
    await PreviewSession.create(cdp);
    expect(calls.map(call => call.method)).toEqual(['Page.enable', 'Page.setLifecycleEventsEnabled', 'Runtime.enable', 'Runtime.addBinding', 'Page.addScriptToEvaluateOnNewDocument']);
  });

  it('passes every mouse field and supplies defaults only for missing fields', async () => {
    const { cdp, sent } = fakeCdp();
    const session = await PreviewSession.create(cdp);
    await session.handle({ t: 'mouse', type: 'mouseWheel', x: 13, y: 27, button: 'right', buttons: 2, clickCount: 3, deltaX: -4, deltaY: 5, modifiers: 8 });
    await session.handle({ t: 'mouse', type: 'mouseMoved', x: 0, y: 0 });
    expect(sent('Input.dispatchMouseEvent').map(call => call.params)).toEqual([
      { type: 'mouseWheel', x: 13, y: 27, button: 'right', buttons: 2, clickCount: 3, deltaX: -4, deltaY: 5, modifiers: 8 },
      { type: 'mouseMoved', x: 0, y: 0, button: 'none', buttons: 0, clickCount: 0, deltaX: 0, deltaY: 0, modifiers: 0 },
    ]);
  });

  it('passes key fields and commands, defaults missing fields, and omits text on keyUp', async () => {
    const { cdp, sent } = fakeCdp();
    const session = await PreviewSession.create(cdp);
    await session.handle({ t: 'key', type: 'keyDown', key: 'a', code: 'KeyA', text: 'A', modifiers: 2, vk: 65, commands: ['selectAll'] });
    await session.handle({ t: 'key', type: 'rawKeyDown' });
    await session.handle({ t: 'key', type: 'keyUp', key: 'a', code: 'KeyA', text: 'ignored', modifiers: 2, vk: 65 });
    expect(sent('Input.dispatchKeyEvent').map(call => call.params)).toEqual([
      { type: 'keyDown', key: 'a', code: 'KeyA', text: 'A', modifiers: 2, windowsVirtualKeyCode: 65, commands: ['selectAll'] },
      { type: 'rawKeyDown', key: '', code: '', text: '', modifiers: 0, windowsVirtualKeyCode: 0 },
      { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 },
    ]);
  });

  it('forwards text and dialog answers exactly', async () => {
    const { cdp, sent } = fakeCdp();
    const session = await PreviewSession.create(cdp);
    await session.handle({ t: 'insertText', text: 'hello é' });
    await session.handle({ t: 'dialogResult', accept: true, text: 'answer' });
    await session.handle({ t: 'dialogResult', accept: false });
    expect(sent('Input.insertText').map(call => call.params)).toEqual([{ text: 'hello é' }]);
    expect(sent('Page.handleJavaScriptDialog').map(call => call.params)).toEqual([{ accept: true, promptText: 'answer' }, { accept: false, promptText: '' }]);
  });

  it.each(['back', 'forward'] as const)('moves %s only when that history entry exists', async direction => {
    const { cdp, sent } = fakeCdp();
    const session = await PreviewSession.create(cdp);
    await session.handle({ t: direction });
    expect(sent('Page.navigateToHistoryEntry').map(call => call.params)).toEqual([{ entryId: direction === 'back' ? 10 : 12 }]);
    vi.mocked(cdp.send).mockResolvedValue({ currentIndex: direction === 'back' ? 0 : 2, entries: [{ id: 10 }, { id: 11 }, { id: 12 }] });
    await session.handle({ t: direction });
    expect(sent('Page.navigateToHistoryEntry')).toHaveLength(1);
  });

  it('ignores host messages and duplicate acknowledgements', async () => {
    const { cdp, calls } = fakeCdp();
    const session = await PreviewSession.create(cdp);
    const before = calls.length;
    await session.handle({ t: 'ack' });
    await session.handle({ t: 'stop', port: 5173 });
    expect(calls).toHaveLength(before);
  });

  it.each([
    { url: 'https://example.test/path', type: 'prompt', defaultPrompt: 'seed', origin: 'https://example.test', prompt: 'seed' },
    { url: 'invalid', type: 'prompt', origin: '', prompt: '' },
    { type: 'alert', origin: '', prompt: undefined },
  ] as const)('reports dialog origins and prompt defaults: $type/$url', async row => {
    const { cdp, emit } = fakeCdp();
    const session = await PreviewSession.create(cdp);
    const viewer = fakeViewer();
    session.attach(viewer);
    emit('Page.javascriptDialogOpening', { type: row.type, message: 'message', ...('url' in row ? { url: row.url } : {}), ...('defaultPrompt' in row ? { defaultPrompt: row.defaultPrompt } : {}) });
    expect(viewer.messages).toEqual([{ t: 'dialog', type: row.type, message: 'message', origin: row.origin, ...(row.type === 'prompt' ? { defaultPrompt: row.prompt } : {}) }]);
    session.close();
  });

  it('uses the current URL for a dialog and ignores other bindings and subframe navigation', async () => {
    const { cdp, emit } = fakeCdp();
    const session = await PreviewSession.create(cdp);
    const viewer = fakeViewer();
    session.attach(viewer);
    emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://example.test/first' } });
    emit('Page.navigatedWithinDocument', { frameId: 'child', url: 'https://child.test/' });
    emit('Runtime.bindingCalled', { name: 'other', payload: 'ignored' });
    expect(session.url).toBe('https://example.test/first');
    emit('Page.navigatedWithinDocument', { frameId: 'main', url: 'https://example.test/second' });
    emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Continue?' });
    expect(session.url).toBe('https://example.test/second');
    expect(viewer.messages).toEqual([
      { t: 'url', url: 'https://example.test/first' }, { t: 'url', url: 'https://example.test/second' },
      { t: 'dialog', type: 'confirm', message: 'Continue?', origin: 'https://example.test' },
    ]);
    session.close();
  });

  it('releases pending and held frames on detach, ignores an old viewer and closes the CDP session', async () => {
    vi.useFakeTimers();
    const { cdp, emit, sent } = fakeCdp();
    const session = await PreviewSession.create(cdp);
    const viewer = fakeViewer();
    session.attach(viewer);
    await vi.advanceTimersByTimeAsync(0);
    session.detach(fakeViewer());
    emit('Page.screencastFrame', frame('first', 0));
    emit('Page.screencastFrame', frame('held', 2));
    session.detach(viewer);
    await vi.advanceTimersByTimeAsync(0);
    expect(viewer.frames).toEqual(['first']);
    expect(sent('Page.screencastFrameAck').map(call => call.params)).toEqual([{ sessionId: 0 }, { sessionId: 2 }]);
    await session.handle({ t: 'ack' });
    expect(sent('Page.screencastFrameAck')).toHaveLength(2);
    const starts = sent('Page.startScreencast').length;
    session.close();
    emit('Page.frameNavigated', { frame: { url: 'https://closed.test/' } });
    emit('Page.screencastFrame', frame('after close', 3));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cdp.close).toHaveBeenCalledOnce();
    expect(sent('Page.startScreencast')).toHaveLength(starts);
    expect(viewer.frames).toEqual(['first']);
  });

  it('announces again after navigation and clears held frames on restart', async () => {
    vi.useFakeTimers();
    const { cdp, emit, sent } = fakeCdp();
    const firstFrame = vi.fn();
    const session = await PreviewSession.create(cdp, { onFirstFrame: firstFrame });
    const viewer = fakeViewer();
    session.attach(viewer);
    await vi.advanceTimersByTimeAsync(0);
    emit('Page.screencastFrame', frame('before', 1));
    emit('Page.screencastFrame', frame('old held', 2));
    await session.handle({ t: 'resize', w: 900, h: 600 });
    await session.navigate('https://example.test/');
    expect(sent('Page.navigate').at(-1)?.params).toEqual({ url: 'https://example.test/' });
    emit('Page.screencastFrame', frame('after', 3));
    await session.handle({ t: 'ack' });
    expect(viewer.frames).toEqual(['before', 'after']);
    expect(firstFrame.mock.calls).toEqual([[viewer], [viewer]]);
    expect(sent('Page.screencastFrameAck').map(call => call.params)).toEqual([{ sessionId: 3 }]);
    session.close();
  });

  it('updates the viewport without a viewer and recovers the queue after a CDP refusal', async () => {
    const { cdp, sent } = fakeCdp();
    const session = await PreviewSession.create(cdp);
    const error = new Error('metrics refused');
    vi.mocked(cdp.send).mockRejectedValueOnce(error);
    await expect(session.handle({ t: 'resize', w: 640, h: 480 })).rejects.toBe(error);
    await session.handle({ t: 'resize', w: 700, h: 500 });
    expect(sent('Page.startScreencast')).toHaveLength(0);
    expect(sent('Emulation.setDeviceMetricsOverride').at(-1)?.params).toEqual({ width: 700, height: 500, deviceScaleFactor: 1, mobile: false });
  });

  it.each([
    { name: 'progressive', bytes: [255, 216, 255, 194, 0, 17, 8, 3, 32, 5, 0], restart: false },
    { name: 'fill byte and skipped segment', bytes: [255, 216, 255, 255, 224, 0, 2, 255, 192, 0, 17, 8, 3, 32, 5, 0], restart: false },
    { name: 'width mismatch', bytes: [255, 216, 255, 192, 0, 17, 8, 3, 32, 5, 1], restart: true },
    { name: 'height mismatch', bytes: [255, 216, 255, 192, 0, 17, 8, 3, 33, 5, 0], restart: true },
    { name: 'truncated SOF', bytes: [255, 216, 255, 192, 0, 17, 8, 3, 32, 5], restart: false },
    { name: 'short header', bytes: [255, 216, 255], restart: false },
    { name: 'bad SOI first byte', bytes: [0, 216, 255, 192, 0, 17, 8, 0, 1, 0, 1], restart: false },
    { name: 'bad SOI second byte', bytes: [255, 0, 255, 192, 0, 17, 8, 0, 1, 0, 1], restart: false },
    { name: 'bad marker prefix', bytes: [255, 216, 0, 192, 0, 17, 8, 0, 1, 0, 1], restart: false },
    ...[191, 196, 200, 204, 208].map(marker => ({ name: `non-SOF ${marker}`, bytes: [255, 216, 255, marker, 0, 9, 8, 0, 1, 0, 1], restart: false })),
  ])('interprets $name JPEG dimensions through stream recovery', async ({ bytes, restart }) => {
    vi.useFakeTimers();
    const { cdp, emit, sent } = fakeCdp();
    const session = await PreviewSession.create(cdp);
    const viewer = fakeViewer();
    session.attach(viewer);
    await vi.advanceTimersByTimeAsync(0);
    emit('Page.screencastFrame', { data: Buffer.from(bytes).toString('base64'), sessionId: 1 });
    expect(viewer.frames).toEqual([Buffer.from(bytes).toString()]);
    await vi.advanceTimersByTimeAsync(499);
    expect(sent('Page.startScreencast')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent('Page.startScreencast')).toHaveLength(restart ? 2 : 1);
    session.close();
  });
});
