import type { PreviewQuality } from '@open-mercato/cezar-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeCdp, fakeViewer } from './preview.testkit.ts';
import { PreviewSession } from './session.ts';

/**
 * Ultra renders at the viewer's pixel ratio (hearsay-tools/cezarion#2069): the window moves to a
 * screen at that ratio, the page renders at it, and the screencast streams the full-size frame.
 * Normal and High, and Ultra at ratio 1, stream exactly as before.
 */

const jpeg = (w: number, h: number) =>
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]).toString('base64');
const flush = () => new Promise(resolve => setImmediate(resolve));

/** A Chromium with one primary screen that adds screens as asked. `refuse` makes one command fail, as an older build does. */
function browser(refuse?: string) {
  const screens: Array<Record<string, unknown>> = [{ id: 'P', availLeft: 0, availTop: 0, devicePixelRatio: 1, isPrimary: true }];
  return fakeCdp((method, params) => {
    if (method === refuse) throw new Error(`${method} wasn't found`);
    if (method === 'Emulation.getScreenInfos') return { screenInfos: [...screens] };
    if (method === 'Browser.getWindowForTarget') return { windowId: 3 };
    if (method === 'Emulation.addScreen') {
      const info = { id: `S${screens.length}`, availLeft: params.left, availTop: 0, devicePixelRatio: params.devicePixelRatio, isPrimary: false };
      screens.push(info);
      return { screenInfo: info };
    }
    return undefined;
  });
}

const DENSITY = new Set(['Emulation.getScreenInfos', 'Emulation.addScreen', 'Browser.getWindowForTarget', 'Browser.setWindowBounds']);

describe('pixel density (hearsay-tools/cezarion#2069)', () => {
  afterEach(() => vi.useRealTimers());

  it('streams Ultra at ratio 2 at twice the size, from a window on a ratio-2 screen', async () => {
    const { cdp, sent, calls } = browser();
    const session = await PreviewSession.create(cdp, { quality: () => 'ultra' });
    session.attach(fakeViewer());
    await session.handle({ t: 'resize', w: 1280, h: 800, dpr: 2 });
    await flush();
    expect(sent('Emulation.addScreen').at(-1)?.params).toMatchObject({ devicePixelRatio: 2 });
    expect(sent('Browser.setWindowBounds').at(-1)?.params).toEqual({ windowId: 3, bounds: { left: 100_000, top: 0 } });
    expect(sent('Emulation.setDeviceMetricsOverride').at(-1)?.params).toEqual({ width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
    expect(sent('Page.startScreencast').at(-1)?.params).toEqual({ format: 'jpeg', quality: 100, maxWidth: 2560, maxHeight: 1600, everyNthFrame: 1 });
    // The window is on its screen before the page renders at the ratio and the stream starts.
    const order = calls.map(call => call.method).filter(method => ['Browser.setWindowBounds', 'Emulation.setDeviceMetricsOverride', 'Page.startScreencast'].includes(method));
    expect(order.slice(-3)).toEqual(['Browser.setWindowBounds', 'Emulation.setDeviceMetricsOverride', 'Page.startScreencast']);
  });

  it.each<[PreviewQuality, number]>([
    ['normal', 2],
    ['high', 2],
    ['ultra', 1],
  ])('streams %s at ratio %d exactly as before: scale 1, no screen moved', async (quality, dpr) => {
    const { cdp, sent, calls } = browser();
    const session = await PreviewSession.create(cdp, { quality: () => quality });
    session.attach(fakeViewer());
    await session.handle({ t: 'resize', w: 646, h: 787, dpr });
    await flush();
    expect(sent('Emulation.setDeviceMetricsOverride').map(call => call.params.deviceScaleFactor)).toEqual([1, 1]);
    expect(sent('Page.startScreencast').at(-1)?.params).toEqual({ format: 'jpeg', quality: quality === 'normal' ? 60 : 100, maxWidth: 646, maxHeight: 787, everyNthFrame: 1 });
    // One read of the screens; a browser with only its primary screen needs no move.
    expect(calls.filter(call => DENSITY.has(call.method)).map(call => call.method)).toEqual(['Emulation.getScreenInfos']);
  });

  it('renders a fractional ratio exactly, and rounds the stream bound up', async () => {
    const { cdp, sent } = browser();
    const session = await PreviewSession.create(cdp, { quality: () => 'ultra' });
    session.attach(fakeViewer());
    await session.handle({ t: 'resize', w: 645, h: 787, dpr: 1.25 });
    await flush();
    expect(sent('Emulation.setDeviceMetricsOverride').at(-1)?.params).toMatchObject({ deviceScaleFactor: 1.25 });
    expect(sent('Page.startScreencast').at(-1)?.params).toMatchObject({ maxWidth: 807, maxHeight: 984 });
  });

  it('restarts at the new ratio when the viewer moves to another display, and only once for a repeat', async () => {
    const { cdp, sent } = browser();
    const session = await PreviewSession.create(cdp, { quality: () => 'ultra' });
    session.attach(fakeViewer());
    await session.handle({ t: 'resize', w: 800, h: 600, dpr: 2 });
    await session.handle({ t: 'resize', w: 800, h: 600, dpr: 2 });
    await session.handle({ t: 'resize', w: 800, h: 600, dpr: 1 });
    await flush();
    expect(sent('Page.startScreencast').map(call => [call.params.maxWidth, call.params.maxHeight])).toEqual([[1280, 800], [1600, 1200], [800, 600]]);
    const lefts = sent('Browser.setWindowBounds').map(call => {
      return (call.params.bounds as { left: number }).left;
    });
    expect(lefts).toEqual([100_000, 0]);
    // No navigation or reload: the page stays as it is.
    expect(sent('Page.navigate')).toHaveLength(0);
    expect(sent('Page.reload')).toHaveLength(0);
  });

  it('switching to and from Ultra moves the window and restarts the stream at the new scale', async () => {
    let quality: PreviewQuality = 'high';
    const { cdp, sent } = browser();
    const session = await PreviewSession.create(cdp, { quality: () => quality });
    session.attach(fakeViewer());
    await session.handle({ t: 'resize', w: 800, h: 600, dpr: 2 });
    await flush();
    quality = 'ultra';
    await session.refreshQuality();
    expect(sent('Emulation.setDeviceMetricsOverride').at(-1)?.params).toMatchObject({ deviceScaleFactor: 2 });
    expect(sent('Page.startScreencast').at(-1)?.params).toMatchObject({ quality: 100, maxWidth: 1600, maxHeight: 1200 });
    quality = 'normal';
    await session.refreshQuality();
    expect(sent('Emulation.setDeviceMetricsOverride').at(-1)?.params).toMatchObject({ deviceScaleFactor: 1 });
    expect(sent('Page.startScreencast').at(-1)?.params).toMatchObject({ quality: 60, maxWidth: 800, maxHeight: 600 });
    expect(sent('Page.navigate')).toHaveLength(0);
  });

  it('switching to Ultra uses the newest ratio, even one that arrived while High streamed at the same size', async () => {
    let quality: PreviewQuality = 'high';
    const { cdp, sent } = browser();
    const session = await PreviewSession.create(cdp, { quality: () => quality });
    session.attach(fakeViewer());
    await session.handle({ t: 'resize', w: 800, h: 600 });
    // The viewer moves to a ratio-2 display: High has nothing to restart, but the ratio is kept.
    await session.handle({ t: 'resize', w: 800, h: 600, dpr: 2 });
    await flush();
    quality = 'ultra';
    await session.refreshQuality();
    expect(sent('Emulation.setDeviceMetricsOverride').at(-1)?.params).toMatchObject({ deviceScaleFactor: 2 });
    expect(sent('Page.startScreencast').at(-1)?.params).toMatchObject({ quality: 100, maxWidth: 1600, maxHeight: 1200 });
  });

  it('a mode change while a resize is in flight still ends at the new mode\'s density', async () => {
    let quality: PreviewQuality = 'high';
    let release!: () => void;
    let hold = false;
    const screens: Array<Record<string, unknown>> = [{ id: 'P', availLeft: 0, availTop: 0, devicePixelRatio: 1, isPrimary: true }];
    const { cdp, sent } = fakeCdp((method, params) => {
      if (method === 'Emulation.getScreenInfos') return { screenInfos: [...screens] };
      if (method === 'Browser.getWindowForTarget') return { windowId: 3 };
      if (method === 'Emulation.addScreen') {
        const info = { id: 'S1', availLeft: params.left, availTop: 0, devicePixelRatio: params.devicePixelRatio, isPrimary: false };
        screens.push(info);
        return { screenInfo: info };
      }
      if (method === 'Emulation.setDeviceMetricsOverride' && hold) {
        hold = false;
        return new Promise<object>(resolve => (release = () => resolve({})));
      }
      return undefined;
    });
    const session = await PreviewSession.create(cdp, { quality: () => quality });
    session.attach(fakeViewer());
    await flush();
    hold = true;
    const resized = session.handle({ t: 'resize', w: 800, h: 600, dpr: 2 });
    await flush();
    // The owner picks Ultra while the High resize waits on Chromium.
    quality = 'ultra';
    const refreshed = session.refreshQuality();
    release();
    await Promise.all([resized, refreshed]);
    expect(sent('Emulation.setDeviceMetricsOverride').at(-1)?.params).toMatchObject({ deviceScaleFactor: 2 });
    expect(sent('Page.startScreencast').at(-1)?.params).toMatchObject({ quality: 100, maxWidth: 1600, maxHeight: 1200 });
  });

  it('a new viewer (a reconnect) streams at its own ratio from the first frame', async () => {
    const { cdp, sent } = browser();
    const session = await PreviewSession.create(cdp, { quality: () => 'ultra' });
    const first = fakeViewer();
    session.attach(first);
    await session.handle({ t: 'resize', w: 800, h: 600, dpr: 2 });
    session.detach(first);
    session.attach(fakeViewer());
    await flush();
    expect(sent('Page.startScreencast').at(-1)?.params).toMatchObject({ maxWidth: 1600, maxHeight: 1200 });
  });

  it('counts a full-size frame at scale 2 as settled and a CSS-size frame as stale', async () => {
    vi.useFakeTimers();
    const { cdp, sent, emit } = browser();
    const session = await PreviewSession.create(cdp, { quality: () => 'ultra' });
    session.attach(fakeViewer());
    await session.handle({ t: 'resize', w: 800, h: 600, dpr: 2 });
    await vi.advanceTimersByTimeAsync(0);
    const starts = sent('Page.startScreencast').length;
    // A frame captured before the window reached its screen: the watchdog restarts the stream.
    emit('Page.screencastFrame', { data: jpeg(800, 600), sessionId: 1 });
    await vi.advanceTimersByTimeAsync(500);
    expect(sent('Page.startScreencast').length).toBe(starts + 1);
    emit('Page.screencastFrame', { data: jpeg(1600, 1200), sessionId: 1 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent('Page.startScreencast').length).toBe(starts + 1);
  });

  it('allows one pixel of rounding at a fractional ratio', async () => {
    vi.useFakeTimers();
    const { cdp, sent, emit } = browser();
    const session = await PreviewSession.create(cdp, { quality: () => 'ultra' });
    session.attach(fakeViewer());
    await session.handle({ t: 'resize', w: 645, h: 787, dpr: 1.25 });
    await vi.advanceTimersByTimeAsync(0);
    const starts = sent('Page.startScreencast').length;
    emit('Page.screencastFrame', { data: jpeg(806, 984), sessionId: 1 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent('Page.startScreencast').length).toBe(starts);
  });

  it('streams Ultra at scale 1 when Chromium cannot add a screen', async () => {
    const { cdp, sent } = browser('Emulation.addScreen');
    const session = await PreviewSession.create(cdp, { quality: () => 'ultra' });
    session.attach(fakeViewer());
    await session.handle({ t: 'resize', w: 800, h: 600, dpr: 2 });
    await flush();
    expect(sent('Emulation.setDeviceMetricsOverride').at(-1)?.params).toMatchObject({ deviceScaleFactor: 1 });
    expect(sent('Page.startScreencast').at(-1)?.params).toMatchObject({ quality: 100, maxWidth: 800, maxHeight: 600 });
  });

  it('a resize from an older cockpit, with no ratio, streams at scale 1', async () => {
    const { cdp, sent } = browser();
    const session = await PreviewSession.create(cdp, { quality: () => 'ultra' });
    session.attach(fakeViewer());
    await session.handle({ t: 'resize', w: 800, h: 600 });
    await flush();
    expect(sent('Page.startScreencast').at(-1)?.params).toMatchObject({ maxWidth: 800, maxHeight: 600 });
  });
});
