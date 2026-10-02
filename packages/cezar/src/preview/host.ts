import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PreviewClientMessage, PreviewServer, PreviewServerMessage, PreviewStateMessage } from '@open-mercato/cezar-contract';
import { z } from 'zod';
import type { RunStore } from '../runs/store.ts';
import { connectCdp, type Cdp } from './cdp.ts';
import { ChromiumError, downloadChromium, downloadTarget, installCommand, launchChromium, resolveChromium } from './chromium.ts';
import { DevServer, probePort, type DevServerState } from './dev-server.ts';
import type { PreviewHostLike } from './registration.ts';
import { PreviewSession, type Viewer } from './session.ts';
import { normalizePreviewUrl } from './url.ts';

/**
 * The workspace-wide preview host (#781, spec 2026-10-02-live-preview-v1): one per server process,
 * because ports are host-global. Keyed by run id, it owns every cezar-started dev server and every
 * task's Chromium, and every exit in the spec's lifecycle table: idle timers, release on worktree
 * removal or run deletion, and shutdown. It never spawns a command on its own: only `run` does.
 */

export const PREVIEW_SERVER_IDLE_MS = 15 * 60_000;
export const PREVIEW_BROWSER_IDLE_MS = 2 * 60_000;
const PROFILE_RELEASE_WAIT_MS = 5_000;
const PROGRESS_EVERY_MS = 250;
const STDERR_TAIL_CHARS = 4096;

export type RunContext = {
  runId: string;
  title: string;
  worktreePath: string;
  dataDir: string;
  store: Pick<RunStore, 'getRun' | 'appendEvent'>;
};

export type PreviewTarget = { port: number } | { url: string };

export type BrowserExit = { signal?: string; stderrTail: string };
/** A launched Chromium with its page's CDP connection. `exited` settles when the process is gone. */
export type BrowserHandle = { cdp: Cdp; exited: Promise<BrowserExit>; close(): void };

/** What the host uses of a `DevServer`: its state, its controls and its two events. */
export type DevServerLike = Pick<DevServer, 'state' | 'attempts' | 'exitCode' | 'stopReason' | 'start' | 'stop' | 'keepWaiting' | 'logTail'> & {
  on(event: 'state', listener: (state: DevServerState) => void): unknown;
  on(event: 'attempt', listener: (attempts: number) => void): unknown;
};

export type PreviewHostDeps = {
  probe?: (port: number) => Promise<boolean>;
  createServer?: (opts: { server: PreviewServer; worktreePath: string; dir: string }) => DevServerLike;
  launchBrowser?: (profileDir: string) => Promise<BrowserHandle>;
  download?: (opts: { signal: AbortSignal; onProgress(received: number, total: number): void }) => Promise<string>;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
  /** /etc/os-release, for the install command. */
  osRelease?: () => string;
};

/** No Chromium anywhere `resolveChromium` looks: the pane offers the download or the OS command. */
export class ChromiumMissingError extends Error {}

type ServerEntry = DevServerLike | 'adopted';

type RunEntry = {
  ctx: RunContext;
  servers: Map<number, ServerEntry>;
  startedAt: Map<number, string>;
  session?: PreviewSession;
  browser?: BrowserHandle;
  launching?: Promise<PreviewSession | undefined>;
  /** Bumped whenever the browser is closed on purpose, so a launch in flight knows it lost. */
  browserGen: number;
  /** Chromium died or would not start: shown until `retryBrowser`, never relaunched on its own. */
  browserFailure?: PreviewStateMessage;
  viewer?: Viewer;
  /** The registered port the viewer is looking at; undefined for a typed URL. */
  port?: number;
  lastUrl?: string;
  adopted: boolean;
  idleTimers: { server?: NodeJS.Timeout; browser?: NodeJS.Timeout };
  released: boolean;
};

const live = (server: ServerEntry | undefined): server is DevServerLike =>
  server !== undefined && server !== 'adopted' && server.state !== 'exited' && server.state !== 'stopped';
const owned = (server: ServerEntry | undefined): server is DevServerLike => server !== undefined && server !== 'adopted';
const serverUrl = (server: PreviewServer) => `http://localhost:${server.port}${server.path ?? '/'}`;

const targetsSchema = z.array(z.object({ type: z.string(), webSocketDebuggerUrl: z.string().optional() }).passthrough());

/** resolve → launch → the page target's CDP socket. */
async function launchBrowser(profileDir: string, env: NodeJS.ProcessEnv): Promise<BrowserHandle> {
  const bin = resolveChromium(undefined, env);
  if (!bin) throw new ChromiumMissingError('No Chromium found');
  const { proc, port } = await launchChromium(bin, profileDir, env);
  let tail = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
  });
  const exited = new Promise<BrowserExit>(resolve =>
    proc.once('exit', (_code, signal) => resolve({ ...(signal ? { signal } : {}), stderrTail: tail })),
  );
  try {
    const targets = targetsSchema.parse(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
    const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
    if (!page?.webSocketDebuggerUrl) throw new ChromiumError('exited', tail, 'Chromium opened no page');
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    return { cdp, exited, close: () => { cdp.close(); proc.kill(); } };
  } catch (error) {
    proc.kill('SIGKILL');
    throw error;
  }
}

function readOsRelease(): string {
  try {
    return readFileSync('/etc/os-release', 'utf8');
  } catch {
    return '';
  }
}

export class PreviewHost implements PreviewHostLike {
  private readonly entries = new Map<string, RunEntry>();
  private readonly deps: Required<Omit<PreviewHostDeps, 'env' | 'platform' | 'arch'>> & { env: NodeJS.ProcessEnv; platform: string; arch: string };
  /** Chromium lands in one shared cache, so there is one download for the whole host. */
  private download?: { controller: AbortController; promise: Promise<string>; watchers: Set<RunEntry> };

  constructor(deps: PreviewHostDeps = {}) {
    const env = deps.env ?? process.env;
    this.deps = {
      probe: deps.probe ?? probePort,
      createServer: deps.createServer ?? (opts => new DevServer(opts)),
      launchBrowser: deps.launchBrowser ?? (profileDir => launchBrowser(profileDir, env)),
      download: deps.download ?? (opts => downloadChromium(opts)),
      osRelease: deps.osRelease ?? readOsRelease,
      env,
      platform: deps.platform ?? process.platform,
      arch: deps.arch ?? process.arch,
    };
  }

  /**
   * A pane asks for a server or a URL. A registered port is probed again now: answering is
   * adopted and streamed, silent asks for approval. Nothing here spawns a command.
   */
  async open(ctx: RunContext, viewer: Viewer, target: PreviewTarget): Promise<void> {
    const entry = this.entryFor(ctx);
    this.claim(entry, viewer);
    if ('url' in target) {
      let url: string;
      try {
        url = normalizePreviewUrl(target.url);
      } catch {
        return;
      }
      entry.port = undefined;
      return this.show(entry, url, false);
    }
    const server = this.registration(entry, target.port);
    if (!server) {
      entry.port = undefined;
      return this.show(entry, `http://localhost:${target.port}/`, false);
    }
    entry.port = server.port;
    const current = entry.servers.get(server.port);
    if (live(current)) return this.report(entry, server.port, current);
    const answering = await this.deps.probe(server.port).catch(() => false);
    if (this.entries.get(ctx.runId) !== entry || entry.viewer !== viewer || entry.port !== server.port) return;
    if (answering) {
      entry.servers.set(server.port, 'adopted');
      return this.show(entry, serverUrl(server), true);
    }
    if (current === 'adopted') entry.servers.delete(server.port);
    // A server cezar ran and lost says so, with its log; Start again is the same approval.
    if (owned(current)) return this.report(entry, server.port, current);
    this.tell(entry, { t: 'state', stage: 'needs-approval', server, wasRunning: current === 'adopted' || server.answeredAtRegistration });
  }

  /** The owner's approval: the only path that runs a registered command. */
  async run(runId: string, port: number): Promise<void> {
    const entry = this.entries.get(runId);
    const server = entry && this.registration(entry, port);
    if (!entry || !server || live(entry.servers.get(port))) return;
    const dev = this.deps.createServer({ server, worktreePath: entry.ctx.worktreePath, dir: this.runDir(entry.ctx) });
    entry.servers.set(port, dev);
    entry.startedAt.set(port, new Date().toISOString());
    entry.port = port;
    dev.on('state', (state: DevServerState) => this.onServerState(entry, port, dev, state));
    // Attempts reach the pane only; the event log records transitions.
    dev.on('attempt', () => {
      if (entry.servers.get(port) === dev && dev.state === 'starting') this.report(entry, port, dev);
    });
    // A DevServer is born `starting` without emitting it, so the host records that transition.
    this.recordState(entry, port, 'starting', dev);
    this.report(entry, port, dev);
    dev.start();
  }

  /** Stops a cezar-owned server. An adopted one is not cezar's to stop: refused with `false`. */
  async stop(runId: string, port: number, reason: 'user' | 'idle'): Promise<boolean> {
    const dev = this.entries.get(runId)?.servers.get(port);
    if (!live(dev)) return false;
    await dev.stop(reason);
    return true;
  }

  keepWaiting(runId: string, port: number): void {
    const dev = this.entries.get(runId)?.servers.get(port);
    if (live(dev)) dev.keepWaiting();
  }

  /** The socket closed. The last viewer leaving starts both idle timers. */
  detach(runId: string, viewer: Viewer): void {
    const entry = this.entries.get(runId);
    if (!entry || entry.viewer !== viewer) return;
    entry.viewer = undefined;
    entry.session?.detach(viewer);
    this.clearIdle(entry);
    entry.idleTimers.browser = setTimeout(() => this.closeBrowser(entry), PREVIEW_BROWSER_IDLE_MS);
    entry.idleTimers.server = setTimeout(() => {
      for (const server of entry.servers.values()) if (live(server)) void server.stop('idle');
    }, PREVIEW_SERVER_IDLE_MS);
  }

  /** Every message a connected pane sends, already validated against the contract. */
  async handle(ctx: RunContext, viewer: Viewer, msg: PreviewClientMessage): Promise<void> {
    if (msg.t === 'open') return this.open(ctx, viewer, msg.target);
    const entry = this.entries.get(ctx.runId);
    if (!entry || entry.viewer !== viewer) return;
    switch (msg.t) {
      case 'run': return this.run(ctx.runId, msg.port);
      case 'stop': await this.stop(ctx.runId, msg.port, 'user'); return;
      case 'keepWaiting': return this.keepWaiting(ctx.runId, msg.port);
      case 'retryBrowser': return this.retryBrowser(entry);
      case 'download': return this.startDownload(entry);
      case 'cancelDownload': this.download?.controller.abort(); return;
      case 'ping': viewer.send({ t: 'pong', ts: msg.ts }); return;
      default:
        // A refused URL or a CDP call on a page that just went away changes nothing for the pane.
        await entry.session?.handle(msg).catch(() => {});
    }
  }

  /**
   * The run's worktree is going, or the run itself: stop its servers, close its browser, tell the
   * pane. The profile survives unless `deleteProfile` (run deletion), which removes the whole
   * `<dataDir>/preview/<runId>/`. `dataDir` covers a run this process never opened.
   */
  async release(runId: string, opts: { deleteProfile?: boolean; dataDir?: string } = {}): Promise<void> {
    const entry = this.entries.get(runId);
    if (entry) await this.releaseEntry(entry, true, opts.deleteProfile === true);
    const dataDir = opts.dataDir ?? entry?.ctx.dataDir;
    if (opts.deleteProfile && dataDir) {
      try {
        // Chromium may still be flushing the profile as it exits.
        rmSync(join(dataDir, 'preview', runId), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch { /* a profile we cannot delete is left behind, never a failed run deletion */ }
    }
  }

  /** The task whose cezar-owned dev server holds `port`. Adopted ports belong to nobody. */
  portOwner(port: number): { runId: string; title: string } | undefined {
    for (const entry of this.entries.values()) {
      if (live(entry.servers.get(port))) return { runId: entry.ctx.runId, title: entry.ctx.title };
    }
    return undefined;
  }

  probe(port: number): Promise<boolean> {
    return this.deps.probe(port);
  }

  /** cezar shuts down: every run is released and every pane closed. */
  async close(): Promise<void> {
    this.download?.controller.abort();
    await Promise.all([...this.entries.values()].map(entry => this.releaseEntry(entry, false, false)));
  }

  private entryFor(ctx: RunContext): RunEntry {
    const existing = this.entries.get(ctx.runId);
    if (existing) {
      existing.ctx = ctx;
      return existing;
    }
    const entry: RunEntry = { ctx, servers: new Map(), startedAt: new Map(), browserGen: 0, adopted: false, idleTimers: {}, released: false };
    this.entries.set(ctx.runId, entry);
    return entry;
  }

  /** One viewer per run: a second one takes over, and the first is told by whom. */
  private claim(entry: RunEntry, viewer: Viewer): void {
    this.clearIdle(entry);
    const previous = entry.viewer;
    if (previous === viewer) return;
    if (previous) {
      entry.session?.detach(previous);
      previous.send({ t: 'replaced', by: viewer.userAgent });
      previous.close(4001, 'replaced');
    }
    entry.viewer = viewer;
    entry.session?.attach(viewer);
  }

  private registration(entry: RunEntry, port: number): PreviewServer | undefined {
    return entry.ctx.store.getRun(entry.ctx.runId)?.previewServers?.find(server => server.port === port);
  }

  private runDir(ctx: RunContext): string {
    return join(ctx.dataDir, 'preview', ctx.runId);
  }

  private onServerState(entry: RunEntry, port: number, dev: DevServerLike, state: DevServerState): void {
    if (entry.servers.get(port) !== dev) return;
    this.recordState(entry, port, state, dev);
    if (entry.port !== port || entry.released) return;
    const server = this.registration(entry, port);
    // Chromium starts for a pane that is open, never for nobody.
    if (state === 'up') {
      if (server && entry.viewer) void this.show(entry, serverUrl(server), false);
    } else {
      this.report(entry, port, dev);
    }
  }

  /** `preview.server-state`, on transitions only. A run already deleted takes no events. */
  private recordState(entry: RunEntry, port: number, state: DevServerState, dev: DevServerLike): void {
    const { runId, store } = entry.ctx;
    if (!store.getRun(runId)) return;
    const reason = dev.stopReason;
    store.appendEvent(runId, {
      type: 'preview.server-state',
      port,
      state,
      ...(state === 'exited' && dev.exitCode !== undefined ? { exitCode: dev.exitCode } : {}),
      ...(state === 'stopped' && (reason === 'user' || reason === 'idle') ? { reason } : {}),
    });
  }

  /** The pane's view of a cezar-owned server that is not streaming. */
  private report(entry: RunEntry, port: number, dev: DevServerLike): void {
    const server = this.registration(entry, port);
    if (!server || entry.port !== port) return;
    const logTail = () => dev.logTail().join('\n');
    switch (dev.state) {
      case 'starting':
        return this.tell(entry, { t: 'state', stage: 'server-starting', server, attempt: dev.attempts, startedAt: entry.startedAt.get(port) ?? new Date().toISOString() });
      case 'stalled':
        return this.tell(entry, { t: 'state', stage: 'server-stalled', server, logTail: logTail() });
      case 'exited':
        return this.tell(entry, { t: 'state', stage: 'server-exited', server, exitCode: dev.exitCode ?? null, logTail: logTail() });
      case 'stopped':
        return this.tell(entry, {
          t: 'state',
          stage: 'server-stopped',
          server,
          reason: dev.stopReason === 'idle' ? 'idle' : 'user',
          lastUrl: entry.session?.url ?? entry.lastUrl ?? serverUrl(server),
        });
      case 'up':
        if (entry.viewer) void this.show(entry, serverUrl(server), false);
        return;
    }
  }

  /** Browser, then page, then the first frame (which the session announces as `streaming`). */
  private async show(entry: RunEntry, url: string, adopted: boolean): Promise<void> {
    // While Chromium is down, the URL it last showed is the one Retry reopens.
    if (entry.browserFailure) return this.tell(entry, entry.browserFailure);
    entry.lastUrl = url;
    entry.adopted = adopted;
    const session = await this.ensureSession(entry);
    if (!session || entry.lastUrl !== url) return;
    this.tell(entry, { t: 'state', stage: 'loading', step: 'page' });
    await session.navigate(url).catch(() => {});
    this.tell(entry, { t: 'state', stage: 'loading', step: 'frame' });
  }

  private ensureSession(entry: RunEntry): Promise<PreviewSession | undefined> {
    if (entry.session) return Promise.resolve(entry.session);
    if (entry.browserFailure) {
      this.tell(entry, entry.browserFailure);
      return Promise.resolve(undefined);
    }
    entry.launching ??= this.launch(entry).finally(() => {
      entry.launching = undefined;
    });
    return entry.launching;
  }

  private async launch(entry: RunEntry): Promise<PreviewSession | undefined> {
    const generation = entry.browserGen;
    this.tell(entry, { t: 'state', stage: 'loading', step: 'browser' });
    let browser: BrowserHandle;
    try {
      browser = await this.deps.launchBrowser(join(this.runDir(entry.ctx), 'profile'));
    } catch (error) {
      this.launchFailed(entry, error);
      return undefined;
    }
    let session: PreviewSession;
    try {
      session = await PreviewSession.create(browser.cdp, {
        onFirstFrame: viewer => viewer.send({ t: 'state', stage: 'streaming', adopted: entry.adopted }),
      });
    } catch (error) {
      browser.close();
      this.launchFailed(entry, error);
      return undefined;
    }
    if (entry.released || entry.browserGen !== generation) {
      session.close();
      browser.close();
      return undefined;
    }
    entry.browser = browser;
    entry.session = session;
    if (entry.viewer) session.attach(entry.viewer);
    void browser.exited.then(exit => this.browserExited(entry, browser, exit));
    return session;
  }

  private launchFailed(entry: RunEntry, error: unknown): void {
    if (error instanceof ChromiumMissingError) return this.tell(entry, this.missingState());
    const stderrTail = error instanceof ChromiumError ? error.stderrTail : error instanceof Error ? error.message : String(error);
    entry.browserFailure = error instanceof ChromiumError && error.kind === 'sandbox'
      ? { t: 'state', stage: 'sandbox-failed', stderrTail }
      : { t: 'state', stage: 'browser-exited', stderrTail, serverUp: this.serverUp(entry) };
    this.tell(entry, entry.browserFailure);
  }

  /** Chromium died under us: say so with the server's state, and wait for the owner's Retry. */
  private browserExited(entry: RunEntry, browser: BrowserHandle, exit: BrowserExit): void {
    if (entry.browser !== browser) return;
    entry.lastUrl = entry.session?.url ?? entry.lastUrl;
    entry.session = entry.browser = undefined;
    entry.browserFailure = {
      t: 'state',
      stage: 'browser-exited',
      ...(exit.signal ? { signal: exit.signal } : {}),
      stderrTail: exit.stderrTail,
      serverUp: this.serverUp(entry),
    };
    this.tell(entry, entry.browserFailure);
  }

  private async retryBrowser(entry: RunEntry): Promise<void> {
    entry.browserFailure = undefined;
    if (entry.lastUrl) return this.show(entry, entry.lastUrl, entry.adopted);
    await this.ensureSession(entry);
  }

  private serverUp(entry: RunEntry): boolean {
    const server = entry.port === undefined ? undefined : entry.servers.get(entry.port);
    return server === 'adopted' || server?.state === 'up';
  }

  private missingState(): PreviewServerMessage {
    return {
      t: 'state',
      stage: 'chromium-missing',
      installCommand: installCommand(this.deps.platform, this.deps.osRelease()),
      canDownload: downloadTarget(this.deps.platform, this.deps.arch) !== undefined,
    };
  }

  private async startDownload(entry: RunEntry): Promise<void> {
    this.tell(entry, { t: 'state', stage: 'downloading', received: 0, total: 0 });
    const download = this.download ?? this.beginDownload(entry);
    download.watchers.add(entry);
    try {
      await download.promise;
    } catch (error) {
      if (entry.released) return;
      this.tell(entry, download.controller.signal.aborted
        ? this.missingState()
        : { t: 'state', stage: 'download-failed', error: error instanceof Error ? error.message : String(error), installCommand: installCommand(this.deps.platform, this.deps.osRelease()) });
      return;
    }
    if (entry.released) return;
    if (entry.lastUrl) await this.show(entry, entry.lastUrl, entry.adopted);
    else await this.ensureSession(entry);
  }

  /** `first` watches before the download starts, so no progress report is lost. */
  private beginDownload(first: RunEntry): NonNullable<PreviewHost['download']> {
    const controller = new AbortController();
    const watchers = new Set<RunEntry>([first]);
    let last = 0;
    const download = { controller, watchers, promise: Promise.resolve('') };
    this.download = download;
    download.promise = this.deps.download({
      signal: controller.signal,
      onProgress: (received, total) => {
        const now = Date.now();
        if (now - last < PROGRESS_EVERY_MS && received < total) return;
        last = now;
        for (const watcher of watchers) this.tell(watcher, { t: 'downloadProgress', received, total });
      },
    });
    void download.promise.catch(() => {}).finally(() => {
      if (this.download === download) this.download = undefined;
    });
    return download;
  }

  private closeBrowser(entry: RunEntry): BrowserHandle | undefined {
    const { browser, session } = entry;
    entry.browserGen += 1;
    entry.browser = entry.session = undefined;
    session?.close();
    browser?.close();
    return browser;
  }

  private clearIdle(entry: RunEntry): void {
    clearTimeout(entry.idleTimers.server);
    clearTimeout(entry.idleTimers.browser);
    entry.idleTimers = {};
  }

  private async releaseEntry(entry: RunEntry, notify: boolean, awaitBrowserExit: boolean): Promise<void> {
    entry.released = true;
    // Gone from the map at once: an open that arrives meanwhile starts a fresh entry.
    if (this.entries.get(entry.ctx.runId) === entry) this.entries.delete(entry.ctx.runId);
    this.clearIdle(entry);
    this.download?.watchers.delete(entry);
    const browser = this.closeBrowser(entry);
    const stops = [...entry.servers.values()].filter(live).map(server => server.stop('release'));
    await Promise.all(stops);
    if (browser && awaitBrowserExit) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([browser.exited, new Promise<void>(resolve => (timer = setTimeout(resolve, PROFILE_RELEASE_WAIT_MS)))]);
      clearTimeout(timer);
    }
    const viewer = entry.viewer;
    entry.viewer = undefined;
    if (!viewer) return;
    if (notify) viewer.send({ t: 'state', stage: 'worktree-removed' });
    else viewer.close(1001, 'cezar is shutting down');
  }

  private tell(entry: RunEntry, msg: PreviewServerMessage): void {
    if (!entry.released) entry.viewer?.send(msg);
  }
}
