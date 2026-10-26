import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PreviewStopRequest, PreviewStopResult, PreviewClientMessage, PreviewServer, PreviewServerMessage, PreviewStateMessage } from '@open-mercato/cezar-contract';
import { z } from 'zod';
import type { RunStore } from '../runs/store.ts';
import type { Cdp, CdpConnection } from './cdp.ts';
import { AgentCdpLink, type AgentClient } from './cdp-proxy.ts';
import { ChromiumError, downloadChromium, downloadTarget, installCommand, launchChromium, resolveChromium } from './chromium.ts';
import { DevServer, probePort, type DevServerState } from './dev-server.ts';
import { previewStopResult, type PreviewHostLike } from './registration.ts';
import { PreviewSession, type Viewer } from './session.ts';
import { normalizePreviewUrl } from './url.ts';

/**
 * The workspace-wide preview host (#781, spec 2026-10-02-live-preview-v1): one per server process,
 * because ports are host-global. Keyed by run id, it owns every cezar-started dev server and every
 * task's Chromium, and every exit in the spec's lifecycle table: idle timers, release on worktree
 * removal or run deletion, and shutdown. It starts commands only on owner approval or agent reuse of that unchanged approval.
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

export type PreviewTarget = { port: number } | { url: string } | { agent: true };

export type BrowserExit = { signal?: string; exitCode?: number; stderrTail: string };
/** A launched Chromium: its page's CDP session, and the browser connection the agent's proxy
 *  opens its own sessions on (hearsay-tools/cezarion#784). `exited` settles when the process is gone. */
export type BrowserHandle = { cdp: Cdp; connection: CdpConnection; pageTargetId?: string | undefined; exited: Promise<BrowserExit>; close(): void };

/**
 * One agent session's right to drive its run's browser (hearsay-tools/cezarion#784). The token is
 * the secret in `CEZ_PREVIEW_CDP_URL`; `revoke` (the session's tool capability ending) closes every
 * socket it opened. `context` is read at each connection: undefined (no worktree) refuses it.
 */
export type AgentGrant = { token: string; revoke(): void };
type GrantEntry = { runId: string; context: () => RunContext | undefined; links: Set<AgentCdpLink> };
/** Why an agent connection was refused, for the proxy route's close reason. */
export type AgentRefusal = { refused: string };

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
  approvals: Map<number, PreviewServer>;
  session?: PreviewSession | undefined;
  browser?: BrowserHandle | undefined;
  launching?: Promise<PreviewSession | undefined> | undefined;
  /** Bumped whenever the browser is closed on purpose, so a launch in flight knows it lost. */
  browserGen: number;
  /** Bumped by every open and every show: a show still waiting for Chromium navigates only if
   *  nothing newer asked for the pane since. */
  targetGen: number;
  /** Chromium died or would not start: shown until `retryBrowser`, never relaunched on its own. */
  browserFailure?: PreviewStateMessage | undefined;
  viewer?: Viewer | undefined;
  /** Retained across detach so a background tab cannot steal a newer viewer on resume. */
  viewerId?: string | undefined;
  /** The registered port the viewer is looking at; undefined for a typed URL. */
  port?: number | undefined;
  lastUrl?: string | undefined;
  adopted: boolean;
  idleTimers: { server?: NodeJS.Timeout | undefined; browser?: NodeJS.Timeout | undefined };
  released: boolean;
  /** Agent CDP connections: each is demand for the browser, like a viewer (hearsay-tools/cezarion#784). */
  agents: Set<AgentCdpLink>;
  /** The session on the page Chromium opened at launch: what a registered server or a typed URL loads in. */
  home?: PreviewSession | undefined;
  /** The page the agent last created, attached to or brought to front. */
  agentTarget?: string | undefined;
  /** The pane asked for the agent's page, and follows it while no other target is asked for. */
  followAgent: boolean;
  /** cezar's own session on the agent's page, while that page is not the home page. */
  followed?: { targetId: string; session: PreviewSession; off: () => void } | undefined;
};

const live = (server: ServerEntry | undefined): server is DevServerLike =>
  server !== undefined && server !== 'adopted' && server.state !== 'exited' && server.state !== 'stopped';
const owned = (server: ServerEntry | undefined): server is DevServerLike => server !== undefined && server !== 'adopted';
const serverUrl = (server: PreviewServer) => `http://localhost:${server.port}${server.path ?? '/'}`;

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

const targetsSchema = z.object({ targetInfos: z.array(z.object({ type: z.string(), targetId: z.string() }).passthrough()) });
const attachedSchema = z.object({ sessionId: z.string() });

/** A closed browser's exit, bounded: a profile is deleted only once Chromium let go of it. */
async function waitForExit(browser: BrowserHandle): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([browser.exited, new Promise<void>(resolve => (timer = setTimeout(resolve, PROFILE_RELEASE_WAIT_MS)))]);
  clearTimeout(timer);
}

/** resolve → launch → a flat session on the page target. */
async function launchBrowser(profileDir: string, env: NodeJS.ProcessEnv): Promise<BrowserHandle> {
  const bin = resolveChromium(undefined, env);
  if (!bin) throw new ChromiumMissingError('No Chromium found');
  const { proc, browser: connection } = await launchChromium(bin, profileDir, env);
  let tail = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
  });
  const exited = new Promise<BrowserExit>(resolve =>
    proc.once('exit', (code, signal) => resolve({ ...(signal ? { signal } : code !== null ? { exitCode: code } : {}), stderrTail: tail })),
  );
  try {
    const root = connection.session(undefined);
    const { targetInfos } = targetsSchema.parse(await root.send('Target.getTargets'));
    const page = targetInfos.find(target => target.type === 'page');
    if (!page) throw new ChromiumError('exited', tail, 'Chromium opened no page');
    const { sessionId } = attachedSchema.parse(await root.send('Target.attachToTarget', { targetId: page.targetId, flatten: true }));
    const cdp = connection.session(sessionId);
    return { cdp, connection, pageTargetId: page.targetId, exited, close: () => { connection.close(); proc.kill(); } };
  } catch (error) {
    connection.close();
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
  private readonly stopping = new Map<DevServerLike, Promise<void>>();
  private readonly entries = new Map<string, RunEntry>();
  private readonly grants = new Map<string, GrantEntry>();
  private readonly deps: Required<Omit<PreviewHostDeps, 'env' | 'platform' | 'arch'>> & { env: NodeJS.ProcessEnv; platform: string; arch: string };
  /** Chromium lands in one shared cache, so there is one download for the whole host. */
  private download?: { controller: AbortController; promise: Promise<string>; watchers: Set<RunEntry> } | undefined;

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
  async open(ctx: RunContext, viewer: Viewer, target: PreviewTarget, options: { viewerId?: string | undefined; resume?: boolean | undefined } = {}): Promise<void> {
    const entry = this.entryFor(ctx);
    if (entry.released) return;
    if (options.resume && ((entry.viewerId !== undefined && entry.viewerId !== options.viewerId) || (entry.viewer && entry.viewer !== viewer && (!options.viewerId || entry.viewerId !== options.viewerId)))) {
      viewer.send({ t: 'replaced', by: entry.viewer?.userAgent ?? 'another tab' });
      viewer.close(4001, 'replaced');
      return;
    }
    entry.viewerId = options.viewerId;
    this.claim(entry, viewer);
    // Whatever this open shows, a show still waiting on Chromium for an older target is stale.
    entry.targetGen += 1;
    if ('agent' in target) {
      entry.port = undefined;
      return this.showAgentPage(entry);
    }
    // A server or a URL loads in cezar's own page; the agent's tab is left as it is.
    this.leaveAgentPage(entry);
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
    // A terminal state can precede process-group teardown. Keep its owned identity until stop settles.
    if (live(current) || (owned(current) && this.stopping.has(current))) return this.report(entry, server.port, current);
    // Another task's server would answer the probe: streaming it here would show that task's app.
    if (this.heldByOther(entry, server)) return;
    const answering = await this.deps.probe(server.port).catch(() => false);
    if (this.entries.get(ctx.runId) !== entry || entry.viewer !== viewer || entry.port !== server.port || entry.servers.get(server.port) !== current) return;
    if (owned(current) && this.stopping.has(current)) return this.report(entry, server.port, current);
    if (answering) {
      entry.servers.set(server.port, 'adopted');
      return this.showServer(entry, server, true, true);
    }
    if (current === 'adopted') entry.servers.delete(server.port);
    // A server cezar ran and lost says so, with its log; Start again is the same approval.
    if (owned(current)) return this.report(entry, server.port, current);
    this.tell(entry, { t: 'state', stage: 'needs-approval', server, wasRunning: current === 'adopted' || server.answeredAtRegistration });
  }

  /** The owner's approval, also reused by stopPreview after checking the saved approval. */
  async run(runId: string, port: number): Promise<void> {
    const entry = this.entries.get(runId);
    const server = entry && this.registration(entry, port);
    if (!entry || entry.released || !server || live(entry.servers.get(port))) return;
    const previous = entry.servers.get(port);
    if (owned(previous) && this.stopping.has(previous)) return;
    if (this.heldByOther(entry, server)) return;
    const dev = this.deps.createServer({ server, worktreePath: entry.ctx.worktreePath, dir: this.runDir(entry.ctx) });
    entry.servers.set(port, dev);
    entry.approvals.set(port, { ...server });
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
    this.armServerIdle(entry);
  }

  /**
   * The agent re-registered `port` with a different command, cwd or path. A server cezar runs
   * from the old registration stops, an adoption is forgotten, and a pane on that port is asked
   * to approve the new command: nothing runs it until the owner does.
   */
  async replaced(runId: string, port: number): Promise<void> {
    const entry = this.entries.get(runId);
    if (!entry) return;
    const current = entry.servers.get(port);
    entry.approvals.delete(port);
    // Keep the old process reachable until teardown finishes: release must await it too.
    if (owned(current)) await this.stopServer(current, 'release');
    if (entry.servers.get(port) === current) entry.servers.delete(port);
    const server = this.registration(entry, port);
    if (server && entry.viewer && entry.port === port) {
      this.tell(entry, { t: 'state', stage: 'needs-approval', server, wasRunning: false });
    }
  }

  /** Stops a cezar-owned server. An adopted one is not cezar's to stop: refused with `false`. */
  async stop(runId: string, port: number, reason: 'user' | 'idle'): Promise<boolean> {
    const dev = this.entries.get(runId)?.servers.get(port);
    if (!live(dev)) return false;
    await this.stopServer(dev, reason);
    return true;
  }

  /** Reuse only the approval attached to this exact owned process, including after a crash. */
  async stopPreview(runId: string, request: PreviewStopRequest, signal?: AbortSignal): Promise<PreviewStopResult> {
    const { port, restart } = request;
    const owner = this.portOwner(port);
    if (owner && owner.runId !== runId) return previewStopResult('port_held');
    const entry = this.entries.get(runId);
    const server = entry && this.registration(entry, port);
    if (signal?.aborted || entry?.released) return previewStopResult('unavailable');
    if (!entry) return previewStopResult('approval_required');
    if (!server) return previewStopResult('not_registered');
    const dev = entry.servers.get(port);
    if (dev === 'adopted') return previewStopResult('adopted');
    const approval = entry.approvals.get(port);
    const approved = () => {
      const current = this.registration(entry, port);
      return !!approval && entry.approvals.get(port) === approval && !!current
        && current.command === approval.command && current.cwd === approval.cwd && current.path === approval.path;
    };
    if (!owned(dev)) return previewStopResult('approval_required');
    await this.stopServer(dev, 'user');
    if (signal?.aborted || entry.released || this.entries.get(runId) !== entry) return previewStopResult('unavailable');
    if (!restart) return previewStopResult('stopped');
    if (!approved()) return previewStopResult('approval_required');
    // Another process can take the port after stop/crash. Never adopt it or spawn over it.
    const answering = await this.deps.probe(port);
    if (signal?.aborted || entry.released || this.entries.get(runId) !== entry) return previewStopResult('unavailable');
    if (!approved()) return previewStopResult('approval_required');
    if (entry.servers.get(port) !== dev) return previewStopResult('unavailable');
    const holder = this.portOwner(port);
    if (holder && holder.runId !== runId) return previewStopResult('port_held');
    if (answering) return previewStopResult('port_in_use');
    await this.run(runId, port);
    return previewStopResult('restarted');
  }

  private stopServer(dev: DevServerLike, reason: 'user' | 'idle' | 'release'): Promise<void> {
    const pending = this.stopping.get(dev);
    if (pending) return pending;
    const stop = dev.stop(reason).finally(() => { this.stopping.delete(dev); });
    this.stopping.set(dev, stop);
    return stop;
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
    // An agent still driving the browser keeps it, and the servers it drives, open.
    if (entry.agents.size > 0) return;
    entry.idleTimers.browser = setTimeout(() => this.closeBrowser(entry), PREVIEW_BROWSER_IDLE_MS);
    this.armServerIdle(entry);
  }

  /** Agent restarts without a viewer need a bound even after the previous idle timer fired. */
  private armServerIdle(entry: RunEntry): void {
    if (entry.viewer || entry.agents.size > 0 || entry.released || entry.idleTimers.server) return;
    entry.idleTimers.server = setTimeout(() => {
      entry.idleTimers.server = undefined;
      for (const server of entry.servers.values()) if (live(server)) void this.stopServer(server, 'idle');
    }, PREVIEW_SERVER_IDLE_MS);
  }

  /** Every message a connected pane sends, already validated against the contract. */
  async handle(ctx: RunContext, viewer: Viewer, msg: PreviewClientMessage): Promise<void> {
    if (msg.t === 'open') return this.open(ctx, viewer, msg.target, msg);
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
   * A new agent session's right to drive `runId`'s browser through the CDP proxy
   * (hearsay-tools/cezarion#784). Nothing starts until the agent connects.
   */
  grantAgent(runId: string, context: () => RunContext | undefined): AgentGrant {
    const token = randomBytes(32).toString('hex');
    const grant: GrantEntry = { runId, context, links: new Set() };
    this.grants.set(token, grant);
    return {
      token,
      revoke: () => {
        if (this.grants.get(token) !== grant) return;
        this.grants.delete(token);
        for (const link of [...grant.links]) link.close(1008, "The agent's session ended");
      },
    };
  }

  /** Whether `token` names a live grant: the proxy route refuses the upgrade before the handshake otherwise. */
  hasAgentGrant(token: string): boolean {
    return this.grants.has(token);
  }

  /**
   * An agent opened the proxy socket. Its connection is demand: the run's Chromium starts when none
   * runs, and no idle timer runs while it stays. A browser that failed stays failed until the
   * owner's Retry, so a page that crashes Chromium cannot loop through the agent either.
   */
  async connectAgent(token: string, client: AgentClient): Promise<AgentCdpLink | AgentRefusal> {
    const grant = this.grants.get(token);
    if (!grant) return { refused: "This preview address is no longer valid: the agent's session ended" };
    const ctx = grant.context();
    if (!ctx) return { refused: 'This task has no worktree, so it has no preview browser' };
    const entry = this.entryFor(ctx);
    if (entry.released) return { refused: 'The preview of this task was released' };
    if (entry.browserFailure) return { refused: 'The preview browser failed; the owner can retry it from the preview pane' };
    this.clearIdle(entry);
    const session = await this.ensureSession(entry);
    const browser = entry.browser;
    const stillValid = () => this.grants.get(token) === grant && this.entries.get(ctx.runId) === entry && !entry.released && entry.browser === browser;
    if (!session || !browser || !stillValid()) {
      this.armIdleWithoutDemand(entry);
      return { refused: entry.browserFailure ? 'The preview browser could not start' : 'The preview browser is not available' };
    }
    let link: AgentCdpLink;
    try {
      link = await AgentCdpLink.open(browser.connection, client, {
        protectedTargetId: browser.pageTargetId,
        onClose: () => this.agentLeft(entry, grant, link),
        onTarget: targetId => void this.agentTargeted(entry, targetId).catch(() => undefined),
      });
    } catch (error) {
      this.armIdleWithoutDemand(entry);
      return { refused: error instanceof Error ? error.message : String(error) };
    }
    if (!stillValid()) {
      link.close(1001, 'The preview browser closed');
      return { refused: 'The preview browser is not available' };
    }
    grant.links.add(link);
    entry.agents.add(link);
    if (entry.agents.size === 1) this.recordAgent(entry, 'connected');
    return link;
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
      const server = entry.servers.get(port);
      if (live(server) || (owned(server) && this.stopping.has(server))) return { runId: entry.ctx.runId, title: entry.ctx.title };
    }
    return undefined;
  }

  /** Whether this host runs the dev server `<runId>/<port>.pid.json` records: the sweep spares it. */
  ownsServer(runId: string, port: number): boolean {
    return live(this.entries.get(runId)?.servers.get(port));
  }

  /** Whether this host runs the run's Chromium (`<runId>/chromium.pid.json`): the sweep spares it. */
  ownsBrowser(runId: string): boolean {
    const entry = this.entries.get(runId);
    return entry !== undefined && (entry.browser !== undefined || entry.launching !== undefined);
  }

  probe(port: number): Promise<boolean> {
    return this.deps.probe(port);
  }

  /** cezar shuts down: every run is released and every pane closed. */
  async close(): Promise<void> {
    this.download?.controller.abort();
    await Promise.all([...this.entries.values()].map(entry => this.releaseEntry(entry, false, false)));
  }

  private agentLeft(entry: RunEntry, grant: GrantEntry, link: AgentCdpLink): void {
    grant.links.delete(link);
    if (!entry.agents.delete(link)) return;
    if (entry.agents.size > 0) return;
    this.recordAgent(entry, 'disconnected');
    this.armIdleWithoutDemand(entry);
  }

  /** The last viewer or agent left: the idle timers start, as `detach` starts them for a pane. */
  private armIdleWithoutDemand(entry: RunEntry): void {
    if (entry.viewer || entry.agents.size > 0 || entry.released) return;
    if (!entry.idleTimers.browser && (entry.browser || entry.launching)) {
      entry.idleTimers.browser = setTimeout(() => this.closeBrowser(entry), PREVIEW_BROWSER_IDLE_MS);
    }
    this.armServerIdle(entry);
  }

  private closeAgents(entry: RunEntry, code: number, reason: string): void {
    // Each close calls agentLeft, which records `disconnected` once the set is empty.
    for (const link of [...entry.agents]) link.close(code, reason);
  }

  /** `preview.agent-browser`, on the first connection and the last close only. */
  private recordAgent(entry: RunEntry, state: 'connected' | 'disconnected'): void {
    const { runId, store } = entry.ctx;
    if (!store.getRun(runId)) return;
    store.appendEvent(runId, { type: 'preview.agent-browser', state });
  }

  /** The pane asked for the agent's page: shown as it is, never navigated. */
  private async showAgentPage(entry: RunEntry): Promise<void> {
    if (entry.browserFailure) return this.tell(entry, entry.browserFailure);
    if (entry.agents.size === 0 || !entry.browser) return this.tell(entry, { t: 'state', stage: 'agent-idle' });
    entry.followAgent = true;
    entry.adopted = false;
    await this.followAgentPage(entry);
  }

  private leaveAgentPage(entry: RunEntry): void {
    entry.followAgent = false;
    this.dropFollowed(entry);
  }

  /** An agent's command made `targetId` its own: the pane follows it when that is a page. */
  private async agentTargeted(entry: RunEntry, targetId: string): Promise<void> {
    const browser = entry.browser;
    if (!browser) return;
    const reply = await browser.connection.call('Target.getTargetInfo', { targetId }, undefined);
    const type = (reply.result as { targetInfo?: { type?: unknown } } | undefined)?.targetInfo?.type;
    if (type !== 'page' || entry.browser !== browser) return;
    entry.agentTarget = targetId;
    if (entry.followAgent) await this.followAgentPage(entry);
  }

  /**
   * Streams the agent's page. The home page streams from the session cezar already has; another
   * page gets a session of cezar's own on it, dropped when the agent closes that page.
   */
  private async followAgentPage(entry: RunEntry): Promise<void> {
    const browser = entry.browser;
    const target = entry.agentTarget;
    if (!browser || !entry.followAgent) return;
    if (!target || target === browser.pageTargetId) {
      this.dropFollowed(entry);
      if (entry.home) this.streamFrom(entry, entry.home);
      return;
    }
    if (entry.followed?.targetId === target) return this.streamFrom(entry, entry.followed.session);
    const opened = await this.openPageSession(browser, target);
    if (!opened) return;
    const { session, sessionId } = opened;
    if (entry.browser !== browser || entry.agentTarget !== target || !entry.followAgent || entry.released || entry.followed?.targetId === target) {
      session.close();
      return;
    }
    this.dropFollowed(entry);
    const off = browser.connection.onEvent(msg => {
      const detached = (msg.params as { sessionId?: unknown } | undefined)?.sessionId;
      if (msg.method === 'Target.detachedFromTarget' && msg.sessionId === undefined && detached === sessionId) this.followedGone(entry, session);
    });
    entry.followed = { targetId: target, session, off };
    this.streamFrom(entry, session);
  }

  /** A session of cezar's own on `targetId`, carrying the page's current URL. */
  private async openPageSession(browser: BrowserHandle, targetId: string): Promise<{ session: PreviewSession; sessionId: string } | undefined> {
    const attached = await browser.connection.call('Target.attachToTarget', { targetId, flatten: true }, undefined);
    const sessionId = attachedSchema.safeParse(attached.result).data?.sessionId;
    if (!sessionId) return undefined;
    let session: PreviewSession;
    try {
      session = await PreviewSession.create(browser.connection.session(sessionId), {
        onFirstFrame: viewer => viewer.send({ t: 'state', stage: 'streaming', adopted: false }),
      });
    } catch {
      browser.connection.request('Target.detachFromTarget', { sessionId }, undefined, () => {});
      return undefined;
    }
    const info = await browser.connection.call('Target.getTargetInfo', { targetId }, undefined);
    const url = (info.result as { targetInfo?: { url?: unknown } } | undefined)?.targetInfo?.url;
    if (typeof url === 'string' && url) session.url ??= url;
    return { session, sessionId };
  }

  /** The agent closed the page the pane followed: the pane shows cezar's own page again. */
  private followedGone(entry: RunEntry, session: PreviewSession): void {
    if (entry.followed?.session !== session) return;
    if (entry.agentTarget === entry.followed.targetId) entry.agentTarget = undefined;
    this.dropFollowed(entry);
  }

  private dropFollowed(entry: RunEntry): void {
    const followed = entry.followed;
    entry.followed = undefined;
    if (!followed) return;
    followed.off();
    if (entry.session === followed.session && entry.home) this.streamFrom(entry, entry.home);
    followed.session.close();
  }

  /**
   * Makes `session` the one the pane streams, with its URL. The viewer is attached only on a change:
   * `claim` already attached it to the current session, and a second attach restarts its screencast.
   */
  private streamFrom(entry: RunEntry, session: PreviewSession): void {
    const viewer = entry.viewer;
    const changed = entry.session !== session;
    if (changed) {
      if (viewer) entry.session?.detach(viewer);
      entry.session = session;
    }
    entry.lastUrl = session.url ?? entry.lastUrl;
    if (!viewer) return;
    if (session.url) viewer.send({ t: 'url', url: session.url });
    if (changed) session.attach(viewer);
  }

  private entryFor(ctx: RunContext): RunEntry {
    const existing = this.entries.get(ctx.runId);
    if (existing) {
      existing.ctx = ctx;
      return existing;
    }
    const entry: RunEntry = { ctx, servers: new Map(), startedAt: new Map(), approvals: new Map(), browserGen: 0, targetGen: 0, adopted: false, idleTimers: {}, released: false, agents: new Set(), followAgent: false };
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

  /** Tells the pane `port-held` when another task's cezar-owned server holds `server.port`. */
  private heldByOther(entry: RunEntry, server: PreviewServer): boolean {
    const owner = this.portOwner(server.port);
    if (!owner || owner.runId === entry.ctx.runId) return false;
    if (entry.servers.get(server.port) === 'adopted') entry.servers.delete(server.port);
    this.tell(entry, { t: 'state', stage: 'port-held', server, ownerTitle: owner.title });
    return true;
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
      // A (re)started server: load the page again, at the one the owner was last on (5.9).
      if (server && entry.viewer) void this.showServer(entry, server, false, false);
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
        return this.tell(entry, { t: 'state', stage: 'server-starting', server, attempt: dev.attempts, startedAt: entry.startedAt.get(port) ?? new Date().toISOString(), logTail: dev.logTail() });
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
        if (entry.viewer) void this.showServer(entry, server, false, true);
        return;
    }
  }

  /** Where a server's page reopens: the page the owner was last on when it is this server's, else the registered root. */
  private serverPage(entry: RunEntry, server: PreviewServer): string {
    const root = serverUrl(server);
    const last = entry.session?.url ?? entry.lastUrl;
    return last && sameOrigin(last, root) ? last : root;
  }

  /**
   * Streams a registered server. With `resume`, a live page already on that server is kept as it
   * is: a reconnect, a takeover or a reopen inside the browser idle window must not throw the owner
   * back to the root and lose their form state. Re-attaching restarts the screencast, so the first
   * frame still announces `streaming`.
   */
  private async showServer(entry: RunEntry, server: PreviewServer, adopted: boolean, resume: boolean): Promise<void> {
    const url = this.serverPage(entry, server);
    const { session, viewer } = entry;
    if (resume && session?.url && viewer && !entry.browserFailure && sameOrigin(session.url, url)) {
      entry.adopted = adopted;
      entry.lastUrl = session.url;
      session.attach(viewer);
      return;
    }
    return this.show(entry, url, adopted);
  }

  /** Browser, then page, then the first frame (which the session announces as `streaming`). */
  private async show(entry: RunEntry, url: string, adopted: boolean): Promise<void> {
    // While Chromium is down, the URL it last showed is the one Retry reopens.
    if (entry.browserFailure) return this.tell(entry, entry.browserFailure);
    entry.lastUrl = url;
    entry.adopted = adopted;
    const generation = ++entry.targetGen;
    const session = await this.ensureSession(entry);
    if (!session || entry.targetGen !== generation) return;
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
      // A release waiting on this launch deletes the profile next: the browser must be gone first.
      if (entry.released) await waitForExit(browser);
      return undefined;
    }
    entry.browser = browser;
    entry.session = entry.home = session;
    if (entry.viewer) session.attach(entry.viewer);
    void browser.exited.then(exit => this.browserExited(entry, browser, exit));
    return session;
  }

  private launchFailed(entry: RunEntry, error: unknown): void {
    // `not-installed`: the binary vanished between resolution and spawn. Same pane as none at all.
    if (error instanceof ChromiumMissingError || (error instanceof ChromiumError && error.kind === 'not-installed')) {
      return this.tell(entry, this.missingState());
    }
    if (error instanceof ChromiumError && error.kind === 'sandbox') {
      entry.browserFailure = { t: 'state', stage: 'sandbox-failed', stderrTail: error.stderrTail };
      return this.tell(entry, entry.browserFailure);
    }
    // A timeout or an early exit says why first: Chromium's own stderr is often unrelated noise.
    const stderrTail = error instanceof ChromiumError
      ? [error.message, error.stderrTail].filter(Boolean).join('\n')
      : error instanceof Error ? error.message : String(error);
    entry.browserFailure = {
      t: 'state',
      stage: 'browser-exited',
      reason: error instanceof ChromiumError && error.kind === 'timeout' ? 'timeout' : 'exited',
      ...(error instanceof ChromiumError && error.signal ? { signal: error.signal } : {}),
      ...(error instanceof ChromiumError && error.exitCode !== undefined ? { exitCode: error.exitCode } : {}),
      stderrTail,
      serverUp: this.serverUp(entry),
    };
    this.tell(entry, entry.browserFailure);
  }

  /** Chromium died under us: say so with the server's state, and wait for the owner's Retry. */
  private browserExited(entry: RunEntry, browser: BrowserHandle, exit: BrowserExit): void {
    if (entry.browser !== browser) return;
    entry.lastUrl = entry.session?.url ?? entry.lastUrl;
    this.forgetPages(entry);
    entry.session = entry.browser = undefined;
    this.closeAgents(entry, 1011, 'The preview browser exited');
    entry.browserFailure = {
      t: 'state',
      stage: 'browser-exited',
      reason: 'exited',
      ...(exit.signal ? { signal: exit.signal } : {}),
      ...(exit.exitCode !== undefined ? { exitCode: exit.exitCode } : {}),
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
    // The page the owner was on outlives the browser: 5.9 shows it, and Start again reopens it.
    entry.lastUrl = session?.url ?? entry.lastUrl;
    const followed = entry.followed?.session;
    this.forgetPages(entry);
    entry.browser = entry.session = undefined;
    this.closeAgents(entry, 1001, 'The preview browser closed');
    followed?.close();
    session?.close();
    browser?.close();
    return browser;
  }

  /** The browser is going: no page of it is home, followed or the agent's any more. */
  private forgetPages(entry: RunEntry): void {
    entry.followed?.off();
    entry.followed = entry.home = entry.agentTarget = undefined;
  }

  private clearIdle(entry: RunEntry): void {
    clearTimeout(entry.idleTimers.server);
    clearTimeout(entry.idleTimers.browser);
    entry.idleTimers = {};
  }

  private async releaseEntry(entry: RunEntry, notify: boolean, awaitBrowserExit: boolean): Promise<void> {
    entry.released = true;
    // Retain ownership while stopping so no run can reuse this port during teardown.
    this.clearIdle(entry);
    this.download?.watchers.delete(entry);
    // A launch in flight has no browser on the entry yet; it sees `released` and closes its own.
    const launching = entry.launching;
    // closeBrowser closes the agents' sockets; their `disconnected` is recorded before the run goes.
    const browser = this.closeBrowser(entry);
    const stops = [...entry.servers.values()].filter(owned).map(server => this.stopServer(server, 'release'));
    await Promise.all(stops);
    if (this.entries.get(entry.ctx.runId) === entry) this.entries.delete(entry.ctx.runId);
    if (awaitBrowserExit) {
      if (browser) await waitForExit(browser);
      if (launching) await launching.catch(() => undefined);
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
