import { describe, expect, it } from 'vitest';
import type { Cdp } from './cdp.ts';
import { PixelDensity } from './density.ts';

const PRIMARY = { id: 'P', availLeft: 0, availTop: 0, devicePixelRatio: 1, isPrimary: true };

/** A page session over a browser whose screens live in `screens`, as Chromium keeps them for every session. */
function fakeBrowser(screens = [PRIMARY], refuse?: string) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let next = 0;
  const cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (method === refuse) throw new Error(`${method}: 'Emulation.addScreen' wasn't found`);
      if (method === 'Emulation.getScreenInfos') return { screenInfos: [...screens] };
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      if (method === 'Emulation.addScreen') {
        const info = { id: `S${++next}`, availLeft: params.left as number, availTop: 0, devicePixelRatio: params.devicePixelRatio as number, isPrimary: false };
        screens.push(info);
        return { screenInfo: info };
      }
      return {};
    },
  } as unknown as Cdp;
  return { cdp, calls, methods: () => calls.map(call => call.method), screens };
}

describe('PixelDensity (hearsay-tools/cezarion#2069)', () => {
  it('leaves a window on a browser with one screen where it is at scale 1, and then sends nothing', async () => {
    const { cdp, methods } = fakeBrowser();
    const density = new PixelDensity(cdp);
    expect(await density.place(1)).toBe(1);
    expect(methods()).toEqual(['Emulation.getScreenInfos']);
    expect(await density.place(1)).toBe(1);
    expect(methods()).toEqual(['Emulation.getScreenInfos']);
  });

  it('adds a screen at the ratio and moves the window onto it', async () => {
    const { cdp, calls } = fakeBrowser();
    const density = new PixelDensity(cdp);
    expect(await density.place(2)).toBe(2);
    expect(calls.find(call => call.method === 'Emulation.addScreen')?.params).toEqual({ left: 100_000, top: 0, width: 16_000, height: 16_000, devicePixelRatio: 2 });
    expect(calls.at(-1)).toEqual({ method: 'Browser.setWindowBounds', params: { windowId: 7, bounds: { left: 100_000, top: 0 } } });
  });

  it('reuses a screen at the same ratio, adds one beside it for another, and goes back to the primary screen at 1', async () => {
    const { cdp, calls, screens } = fakeBrowser();
    const density = new PixelDensity(cdp);
    await density.place(2);
    await density.place(1.5);
    await density.place(2);
    expect(screens.map(screen => [screen.availLeft, screen.devicePixelRatio])).toEqual([[0, 1], [100_000, 2], [120_000, 1.5]]);
    await density.place(1);
    const moves = calls.filter(call => call.method === 'Browser.setWindowBounds').map(call => {
      return (call.params.bounds as { left: number }).left;
    });
    expect(moves).toEqual([100_000, 120_000, 100_000, 0]);
    // The window id is read once.
    expect(calls.filter(call => call.method === 'Browser.getWindowForTarget')).toHaveLength(1);
  });

  it('moves a window an earlier session left on an extra screen back to the primary screen', async () => {
    const left = { id: 'S0', availLeft: 100_000, availTop: 0, devicePixelRatio: 2, isPrimary: false };
    const { cdp, calls } = fakeBrowser([PRIMARY, left]);
    expect(await new PixelDensity(cdp).place(1)).toBe(1);
    expect(calls.at(-1)).toEqual({ method: 'Browser.setWindowBounds', params: { windowId: 7, bounds: { left: 0, top: 0 } } });
  });

  it.each(['Emulation.getScreenInfos', 'Emulation.addScreen', 'Browser.setWindowBounds'])('streams at scale 1 for good when Chromium refuses %s', async refused => {
    const { cdp, calls } = fakeBrowser([PRIMARY], refused);
    const density = new PixelDensity(cdp);
    expect(await density.place(2)).toBe(1);
    const sent = calls.length;
    expect(await density.place(2)).toBe(1);
    expect(await density.place(1)).toBe(1);
    expect(calls).toHaveLength(sent);
  });
});
