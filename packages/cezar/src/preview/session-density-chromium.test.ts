import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PreviewQuality } from '@open-mercato/cezar-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { launchBrowser, waitForExit, type BrowserHandle } from './browser-launch.ts';
import { resolveChromium } from './chromium.ts';
import { PreviewSession, type Viewer } from './session.ts';

/**
 * Ultra against a real Chromium (hearsay-tools/cezarion#2069): the frames are the viewport times
 * the viewer's pixel ratio, and switching back streams CSS-size frames again, with the page as it
 * was. Skipped where no Chromium is installed.
 */

// bound: a cold Chrome start on a loaded CI runner took over 30 s (hearsay-tools/cezarion#1467);
// every wait below still ends on its own event.
const BUDGET_MS = 120_000;
const bin = resolveChromium();

let cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function jpegSize(frame: Buffer): string | undefined {
  for (let at = 2; at + 9 <= frame.length; at += 2 + frame.readUInt16BE(at + 2)) {
    const marker = frame[at + 1]!;
    if (marker >= 0xc0 && marker <= 0xc2) return `${frame.readUInt16BE(at + 7)}x${frame.readUInt16BE(at + 5)}`;
  }
  return undefined;
}

describe('Ultra streams at the viewer pixel ratio in a real Chromium (hearsay-tools/cezarion#2069)', () => {
  it.skipIf(process.platform === 'win32' || !bin)('streams 2x frames at ratio 2 and CSS-size frames back in High, keeping the page', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'cez-density-'));
    let browser: BrowserHandle | undefined;
    cleanups.push(async () => {
      if (browser) {
        browser.close();
        await waitForExit(browser);
      }
      rmSync(profile, { recursive: true, force: true });
    });
    browser = await launchBrowser(profile, process.env);
    let quality: PreviewQuality = 'ultra';
    const session = await PreviewSession.create(browser.cdp, { quality: () => quality });
    cleanups.push(() => session.close());

    // Every frame is acked at once; a waiter settles on the first frame of the size it names.
    const waiters: Array<{ size: string; resolve(): void }> = [];
    const viewer: Viewer = {
      sendFrame(buf) {
        const size = jpegSize(buf);
        for (const waiter of waiters.splice(0)) (waiter.size === size ? waiter.resolve() : waiters.push(waiter));
        void session.handle({ t: 'ack' });
      },
      send() {},
      close() {},
      userAgent: 'test',
    };
    const frameOf = (size: string) => new Promise<void>(resolve => waiters.push({ size, resolve }));

    const evaluate = async (expression: string) => {
      const reply = await browser!.cdp.send<{ result: { value: unknown } }>('Runtime.evaluate', { expression, returnByValue: true });
      return reply.result.value;
    };
    // A page that paints all the time, so a restarted stream always has a next frame. `Page.navigate`
    // answers before the new document loads, so the field is filled only after its load event.
    const loaded = new Promise<void>(resolve => {
      const off = browser!.cdp.on('Page.loadEventFired', () => {
        off();
        resolve();
      });
    });
    await session.navigate('data:text/html,<input id=field><script>setInterval(()=>document.title=Date.now(),16)</script>');
    await loaded;
    expect(await evaluate('document.getElementById("field").value = "kept"')).toBe('kept');

    const ultra = frameOf('1600x1200');
    session.attach(viewer);
    await session.handle({ t: 'resize', w: 800, h: 600, dpr: 2 });
    await ultra;
    expect(await evaluate('devicePixelRatio')).toBe(2);

    const high = frameOf('800x600');
    quality = 'high';
    await session.refreshQuality();
    await high;
    expect(await evaluate('devicePixelRatio')).toBe(1);
    expect(await evaluate('document.getElementById("field").value')).toBe('kept');

    const fractional = frameOf('1200x900');
    quality = 'ultra';
    await session.handle({ t: 'resize', w: 800, h: 600, dpr: 1.5 });
    await fractional;
  }, BUDGET_MS);

  it.skipIf(process.platform === 'win32' || !bin)('streams 2x frames from a tab an agent created, and leaves it at ratio 1 when the pane switches away', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'cez-density-tab-'));
    let browser: BrowserHandle | undefined;
    cleanups.push(async () => {
      if (browser) {
        browser.close();
        await waitForExit(browser);
      }
      rmSync(profile, { recursive: true, force: true });
    });
    browser = await launchBrowser(profile, process.env);
    // As an agent does through the CDP proxy: a new target, then a flat page session on it.
    const root = browser.connection.session(undefined);
    const { targetId } = await root.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await root.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const page = browser.connection.session(sessionId);
    const session = await PreviewSession.create(page, { quality: () => 'ultra' });
    cleanups.push(() => session.close());
    const waiters: Array<{ size: string; resolve(): void }> = [];
    const viewer: Viewer = {
      sendFrame(buf) {
        const size = jpegSize(buf);
        for (const waiter of waiters.splice(0)) (waiter.size === size ? waiter.resolve() : waiters.push(waiter));
        void session.handle({ t: 'ack' });
      },
      send() {},
      close() {},
      userAgent: 'test',
    };
    const ultra = new Promise<void>(resolve => waiters.push({ size: '1600x1200', resolve }));
    const loaded = new Promise<void>(resolve => {
      const off = page.on('Page.loadEventFired', () => {
        off();
        resolve();
      });
    });
    await session.navigate('data:text/html,<p>agent tab</p><script>setInterval(()=>document.title=Date.now(),16)</script>');
    await loaded;
    session.attach(viewer);
    await session.handle({ t: 'resize', w: 800, h: 600, dpr: 2 });
    await ultra;
    const reply = await page.send<{ result: { value: unknown } }>('Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true });
    expect(reply.result.value).toBe(2);

    // The pane switches away, as the host drops a followed tab: detach, then close at once. The
    // window position outlives the session, so a fresh session on the tab must find it at ratio 1.
    const detached = new Promise<void>(resolve => {
      const off = browser!.connection.onEvent(msg => {
        if (msg.method !== 'Target.detachedFromTarget' || (msg.params as { sessionId?: string }).sessionId !== sessionId) return;
        off();
        resolve();
      });
    });
    session.detach(viewer);
    session.close();
    await detached;
    const again = await root.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const after = await browser.connection.session(again.sessionId).send<{ result: { value: unknown } }>('Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true });
    expect(after.result.value).toBe(1);
  }, BUDGET_MS);
});
