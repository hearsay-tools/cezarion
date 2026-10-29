import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchBrowser } from './browser-launch.ts';
import { chromiumArgs, resolveChromium } from './chromium.ts';

// bound: real Chromium startup and GPU initialization can exceed 30 s on loaded CI hosts.
const BUDGET_MS = 120_000;

it('requests headless GPU discovery without choosing a backend or disabling software fallback', () => {
  const args = chromiumArgs('/profile', {});
  expect(args).toContain('--enable-gpu');
  expect(args.some(arg => /^--(?:use-angle|use-gl|use-vulkan|ignore-gpu-blocklist|disable-software-rasterizer|disable-gpu-sandbox)(?:=|$)/.test(arg))).toBe(false);
  expect(args).not.toContain('--no-sandbox');
});

afterEach(() => vi.unstubAllEnvs());

describe('Preview graphics with real Chromium', () => {
  // Mesa's software override is Linux-specific; other hosts exercise their default backend.
  const modes = process.platform === 'linux' ? ['host', 'software'] as const : ['host'] as const;
  it.skipIf(process.platform === 'win32' || !resolveChromium()).each(modes)('streams a painted page with %s graphics', async mode => {
    if (mode === 'software') {
      // Remove display access and force Mesa's CPU renderer, including on GPU-equipped hosts.
      vi.stubEnv('DISPLAY', undefined);
      vi.stubEnv('WAYLAND_DISPLAY', undefined);
      vi.stubEnv('LIBGL_ALWAYS_SOFTWARE', '1');
    }
    const dir = mkdtempSync(join(tmpdir(), 'cez-preview-gpu-'));
    try {
      const browser = await launchBrowser(join(dir, 'profile'), { ...process.env, CEZ_PREVIEW_NO_SANDBOX: '1' });
      try {
        const { cdp } = browser;
        await cdp.send('Page.enable');
        const loaded = new Promise<void>(resolve => {
          const off = cdp.on('Page.loadEventFired', () => { off(); resolve(); });
        });
        await cdp.send('Page.navigate', { url: 'data:text/html,<body style="background:rgb(20,100,200)"><canvas id="c"></canvas>' });
        await loaded;
        const { result } = await cdp.send<{ result: { value: number[] } }>('Runtime.evaluate', {
          expression: `(() => {
            const ctx = document.getElementById('c').getContext('2d');
            ctx.fillStyle = 'rgb(20,100,200)'; ctx.fillRect(0,0,10,10);
            return Array.from(ctx.getImageData(0,0,1,1).data);
          })()`,
          returnByValue: true,
        });
        expect(result.value).toEqual([20, 100, 200, 255]);
        const frame = new Promise<string>(resolve => {
          const off = cdp.on<{ data: string; sessionId: number }>('Page.screencastFrame', event => {
            off();
            void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId });
            resolve(event.data);
          });
        });
        await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60 });
        expect(Buffer.from(await frame, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
        await cdp.send('Page.stopScreencast');
        if (mode === 'software' && process.platform === 'linux') {
          const info = await browser.connection.session(undefined).send<{ gpu: { featureStatus: Record<string, string> } }>('SystemInfo.getInfo');
          expect(info.gpu.featureStatus.gpu_compositing).not.toBe('enabled');
        }
      } finally {
        browser.close();
        await browser.exited;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, BUDGET_MS);
});
