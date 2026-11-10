import type { BrowserHandle } from './browser-launch.ts';

/** How long a closed Chromium may take to exit before it gets SIGKILL. */
const BROWSER_KILL_GRACE_MS = 5_000;

/**
 * Every preview process of a project, followed to its real exit for a project migration fence:
 * the browsers closed (SIGKILL after the grace) and the dev servers stopping, by data directory.
 */
export class ProjectExits {
  private readonly browsers = new Map<BrowserHandle, { dataDir: string; exited: Promise<void> }>();
  private readonly servers = new WeakMap<object, string>();

  /** Close `browser` and follow its process until it has exited. */
  closeBrowser(browser: BrowserHandle, dataDir: string): void {
    browser.close();
    if (this.browsers.has(browser)) return;
    const kill = setTimeout(() => browser.kill?.(), BROWSER_KILL_GRACE_MS);
    kill.unref?.();
    const exited = browser.exited.then(() => undefined, () => undefined).finally(() => {
      clearTimeout(kill);
      this.browsers.delete(browser);
    });
    this.browsers.set(browser, { dataDir, exited });
  }

  /** The project of a dev server the host started. */
  server(dev: object, dataDir: string): void {
    this.servers.set(dev, dataDir);
  }

  /** Settles once every closed browser and every stop in `stopping` of `dataDir` has ended. No
   *  bound: the fence's own bound turns a process that never exits into a refusal. */
  async idle(dataDir: string, stopping: ReadonlyMap<object, Promise<void>>): Promise<void> {
    await Promise.all([
      ...[...this.browsers.values()].filter((closing) => closing.dataDir === dataDir).map((closing) => closing.exited),
      ...[...stopping].filter(([dev]) => this.servers.get(dev) === dataDir).map(([, stop]) => stop.catch(() => undefined)),
    ]);
  }
}
