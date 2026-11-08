import { afterEach, describe, expect, it, vi } from 'vitest';
import { testHome } from '../home/test-home.testkit.ts';
import { downloadChromium } from './chromium.ts';
import { ChromiumMissingError, PreviewHost, type RunContext } from './host.ts';
import { fakeStore } from './host.testkit.ts';
import { fakeViewer } from './preview.testkit.ts';

vi.mock('./chromium.ts', async importOriginal => ({
  ...await importOriginal<typeof import('./chromium.ts')>(),
  downloadChromium: vi.fn(),
}));

// Never let a host mutant reach a real browser or server process.
vi.mock('./browser-launch.ts', async importOriginal => ({
  ...await importOriginal<typeof import('./browser-launch.ts')>(),
  launchBrowser: vi.fn().mockRejectedValue(new Error('Browser launch disabled in download tests')),
}));
vi.mock('./dev-server.ts', () => ({
  probePort: vi.fn().mockResolvedValue(false),
  DevServer: vi.fn(() => { throw new Error('Server launch disabled in download tests'); }),
}));

describe('PreviewHost default downloader', () => {
  const hosts: PreviewHost[] = [];
  afterEach(async () => {
    await Promise.all(hosts.splice(0).map(host => host.close()));
    vi.mocked(downloadChromium).mockReset();
  });

  function setup() {
    const home = testHome();
    const launchBrowser = vi.fn().mockRejectedValue(new ChromiumMissingError());
    const host = new PreviewHost({ home, launchBrowser, platform: 'linux', arch: 'x64', osRelease: () => 'ID=ubuntu\n' });
    hosts.push(host);
    const ctx: RunContext = {
      runId: 'run-1', title: 'Download preview browser', worktreePath: home.root,
      dataDir: home.data, store: fakeStore([]) as unknown as RunContext['store'],
    };
    return { host, ctx, home, launchBrowser, viewer: fakeViewer() };
  }

  it('uses the supplied home cache, forwards progress and retries the requested page after downloading', async () => {
    const { host, ctx, home, viewer, launchBrowser } = setup();
    vi.mocked(downloadChromium).mockImplementation(async ({ onProgress }) => {
      onProgress(10, 10);
      return '/fake/chromium';
    });
    await host.open(ctx, viewer, { url: 'http://localhost:3000/' });
    expect(launchBrowser).toHaveBeenCalledTimes(1);

    await host.handle(ctx, viewer, { t: 'download' });

    expect(downloadChromium).toHaveBeenCalledExactlyOnceWith({
      cacheDir: home.cache, signal: expect.any(AbortSignal), onProgress: expect.any(Function),
    });
    expect(viewer.messages).toContainEqual({ t: 'downloadProgress', received: 10, total: 10 });
    expect(launchBrowser).toHaveBeenCalledTimes(2);
    expect(viewer.messages.at(-1)).toMatchObject({ t: 'state', stage: 'chromium-missing' });
  });

  it('cancels the default download through its signal and returns to the install prompt', async () => {
    const { host, ctx, viewer, launchBrowser } = setup();
    let signal: AbortSignal | undefined;
    vi.mocked(downloadChromium).mockImplementation(options => {
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('Download cancelled')), { once: true });
      });
    });
    await host.open(ctx, viewer, { url: 'http://localhost:3000/' });
    const pending = host.handle(ctx, viewer, { t: 'download' });
    expect(signal?.aborted).toBe(false);
    expect(viewer.messages.at(-1)).toEqual({ t: 'state', stage: 'downloading', received: 0, total: 0 });

    await host.handle(ctx, viewer, { t: 'cancelDownload' });
    await pending;

    expect(signal?.aborted).toBe(true);
    expect(launchBrowser).toHaveBeenCalledTimes(1);
    expect(viewer.messages.at(-1)).toEqual({
      t: 'state', stage: 'chromium-missing', installCommand: 'sudo snap install chromium', canDownload: true,
    });
  });
});
