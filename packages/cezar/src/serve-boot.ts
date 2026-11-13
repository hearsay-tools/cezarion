import { productName } from './home/display.ts';
import type { detectEnvironment } from './core/backend-detect.ts';
import type { DelegationController } from './delegation/provision.ts';
import type { startServer } from './server/start-server.ts';
import { recoverWithProviderRuntimeAuthObservation, type ProviderRuntimeAuthObserver } from './server/provider-auth-runtime.ts';
import type { Home } from './home/home.ts';
import { forwardToSessionGroups } from './core/session-process.ts';
import { pruneOrphans } from './git-worktree.ts';
import { DEFAULT_WORKTREE_RETENTION, resolveWorktreeRetention } from './config.ts';
import { reclaimWorktrees } from './runs/retention.ts';
import { sweepMergedBranches } from './server/repo-branch-sweep.ts';
import type { RunStore } from './runs/store.ts';
import type { RunManager } from './workflows/run.ts';
import type { PreviewHost } from './preview/host.ts';
import type { getRepoInfo } from './server/git.ts';

const reconcileDefaults = { pruneOrphans, resolveWorktreeRetention, reclaimWorktrees, sweepMergedBranches, log: (line: string) => console.log(line) };

export async function reconcileServeWorktrees(
  repoRoot: string,
  repo: Awaited<ReturnType<typeof getRepoInfo>>,
  store: RunStore,
  manager: RunManager,
  previewHost: PreviewHost | undefined,
  steps = reconcileDefaults,
  home: Home,
): Promise<void> {
  // Startup reconcile (spec 006): sweep worktrees whose run no longer exists. Never over a store
  // that could not open (#779): its runs are unknown, and every worktree would look orphaned.
  if (repo && !store.unavailable) {
    const orphans = await steps.pruneOrphans(repoRoot, new Set(store.listRunIds())).catch(
      () => [] as string[],
    );
    if (orphans.length > 0) {
      steps.log(`  cleaned ${orphans.length} orphaned worktree(s): ${orphans.map((id) => id.slice(0, 8)).join(', ')}`);
    }
    // Count-based worktree retention (#483): reclaim finished worktrees beyond
    // the keep-limit (directory only — `cez/<id8>` branch kept, so recoverable).
    // Best-effort; never blocks boot.
    const keep = await steps.resolveWorktreeRetention(repoRoot, home).catch(() => DEFAULT_WORKTREE_RETENTION);
    const reclaimed = await steps.reclaimWorktrees(repoRoot, store, keep, { previewHost }).catch(() => [] as string[]);
    if (reclaimed.length > 0) {
      steps.log(`  reclaimed ${reclaimed.length} old worktree(s), branch kept: ${reclaimed.map((id) => id.slice(0, 8)).join(', ')}`);
    }
    // Branches whose work landed (hearsay-tools/cezarion#2268). In the background: it may ask
    // GitHub, and boot never waits on the network.
    void steps.sweepMergedBranches({ root: repoRoot, store, manager, home }, { keep });
  }
}

export async function recoverServeProject(
  store: RunStore,
  manager: RunManager,
  providerRuntimeAuth: ProviderRuntimeAuthObserver,
  delegation: DelegationController,
  bootProjectId?: string,
  recover = recoverWithProviderRuntimeAuthObservation,
): Promise<void> {
  const recovered = store
    .listRuns()
    .filter((r) => ['queued', 'waiting', 'running'].includes(r.status)).length;
  if (!store.unavailable) {
    await recover(
      store,
      () => manager.recover(),
      providerRuntimeAuth,
    );
    // Boot project never enters ProjectContexts.build(); same sweep that path runs after recover.
    store.compressArchivedHistory();
    delegation.service.armDestroyRetries(bootProjectId ?? 'default');
  }
  if (recovered > 0) console.log(`  recovered ${recovered} run(s) from the previous session`);
}

export function warnServeBind(bindHost: string | undefined, port: number): void {
  // SECURITY: Squawk executes agents. A non-loopback bind exposes that box to
  // whatever can reach the interface, and Squawk itself has NO auth — it is only
  // for a deliberate hosted setup where a reverse proxy in front provides TLS +
  // auth (see `server-install --external-proxy`). Say so, loudly, every start.
  if (bindHost && !['127.0.0.1', 'localhost', '::1'].includes(bindHost)) {
    console.log(
      `\n  ⚠ binding ${bindHost}:${port} — ${productName('cezar')} has no built-in auth.\n` +
        `    Only do this behind a reverse proxy that enforces authentication,\n` +
        `    and make sure this interface is not reachable from the internet.\n`,
    );
  }
}

type StoppableServer = Pick<ReturnType<typeof startServer>, 'shutdownForRestart'>;

/** How long a stop waits for the server's own shutdown. A socket the listener still holds, or a
 *  step that hangs, must not keep this process, its store or its agents alive. */
export const STOP_SERVE_BOUND_MS = 5_000;

export interface StopServeOptions {
  /** The boot store: closed here when the server's shutdown failed or did not finish in time. */
  store?: Pick<RunStore, 'close'> | undefined;
  boundMs?: number;
  forward?: (signal: NodeJS.Signals) => void;
}

/**
 * The one teardown every exit from `serve` runs: a signal or the desktop shell closing stdin. The server's own shutdown stops dev servers, delegation, the listener
 * and the store, waited for at most `boundMs`. Whatever happened there, the store is closed and
 * the signal goes to every agent session group: agents lead their own process groups
 * (hearsay-tools/cezarion#890), so nothing above reaches them. The signal goes last: with the store
 * closed, an agent it ends cannot settle its run, and the next process's recovery resumes it.
 */
export async function stopServe(server: StoppableServer, signal: NodeJS.Signals = 'SIGTERM', opts: StopServeOptions = {}): Promise<void> {
  const { store, boundMs = STOP_SERVE_BOUND_MS, forward = forwardToSessionGroups } = opts;
  let finished = false;
  const shutdown = Promise.resolve().then(() => server.shutdownForRestart()).then(() => { finished = true; });
  let timer: NodeJS.Timeout | undefined;
  // Not unref'd: the bound is what ends this wait when nothing else keeps the process alive.
  const bound = new Promise<void>((resolve) => { timer = setTimeout(resolve, boundMs); });
  try {
    await Promise.race([shutdown, bound]);
  } catch {
    // A failed step must not skip the rest; the finally block below runs it.
  } finally {
    clearTimeout(timer);
    shutdown.catch(() => undefined);
    if (!finished) {
      try { store?.close(); } catch { /* the step that failed may have closed it already */ }
    }
    forward(signal);
  }
}

export function printServeBanner(
  version: string,
  repoRoot: string,
  repo: Awaited<ReturnType<typeof getRepoInfo>>,
  checks: Awaited<ReturnType<typeof detectEnvironment>>,
  url: string,
): void {
  console.log(`\n  ${productName('cezar')} v${version} — ${repoRoot}`);
  console.log(`  ${repo ? `branch ${repo.branch}` : 'not a git repository (tasks run in place, one at a time; repo view is empty)'}`);
  for (const check of checks) {
    const mark = check.available ? '✓' : '✗';
    const detail = check.available ? (check.version ?? 'ok') : (check.hint ?? 'missing');
    console.log(`  ${mark} ${check.name.padEnd(6)} ${detail}`);
  }
  console.log(`\n  cockpit → ${url}\n`);
}
