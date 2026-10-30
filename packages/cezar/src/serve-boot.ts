import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { detectEnvironment } from './core/backend-detect.ts';
import type { DelegationController } from './delegation/provision.ts';
import type { startServer } from './server/server.ts';
import { recoverWithProviderRuntimeAuthObservation, type ProviderRuntimeAuthObserver } from './server/provider-auth-runtime.ts';
import { cezarHomeDir } from './paths.ts';
import { readNpmConfiguration } from './application-update/npm-process.ts';
import { restartEndpoint } from './application-update/helper.ts';
import { armRestartHelper } from './application-update/launcher.ts';
import { ApplicationUpdateService } from './application-update/service.ts';
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
  previewHost?: PreviewHost,
  steps = reconcileDefaults,
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
    const keep = await steps.resolveWorktreeRetention(repoRoot).catch(() => DEFAULT_WORKTREE_RETENTION);
    const reclaimed = await steps.reclaimWorktrees(repoRoot, store, keep, { previewHost }).catch(() => [] as string[]);
    if (reclaimed.length > 0) {
      steps.log(`  reclaimed ${reclaimed.length} old worktree(s), branch kept: ${reclaimed.map((id) => id.slice(0, 8)).join(', ')}`);
    }
    // Branches whose work landed (hearsay-tools/cezarion#2268). In the background: it may ask
    // GitHub, and boot never waits on the network.
    void steps.sweepMergedBranches({ root: repoRoot, store, manager }, { keep });
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
  // SECURITY: cezar executes agents. A non-loopback bind exposes that box to
  // whatever can reach the interface, and cezar itself has NO auth — it is only
  // for a deliberate hosted setup where a reverse proxy in front provides TLS +
  // auth (see `server-install --external-proxy`). Say so, loudly, every start.
  if (bindHost && !['127.0.0.1', 'localhost', '::1'].includes(bindHost)) {
    console.log(
      `\n  ⚠ binding ${bindHost}:${port} — cezar has no built-in auth.\n` +
        `    Only do this behind a reverse proxy that enforces authentication,\n` +
        `    and make sure this interface is not reachable from the internet.\n`,
    );
  }
}

export function createServeApplicationUpdate(
  repoRoot: string,
  update: { latest?: string },
  getServer: () => ReturnType<typeof startServer>,
  readNpm = readNpmConfiguration,
): ApplicationUpdateService | undefined {
  // Discovery reads npm metadata only; a missing npm or source checkout degrades to manual update.
  const npm = readNpm();
  const npmPrefix = npm?.prefix;
  const npmCache = npm?.cache;
  return (npmPrefix && npmCache) || process.env.CEZ_DRY_RUN === '1'
    ? new ApplicationUpdateService({
      packageRoot: join(dirname(fileURLToPath(import.meta.url)), '..'),
      launchEntry: resolve(process.argv[1] ?? ''),
      npmPrefix: npmPrefix ?? join(cezarHomeDir(), 'dry-prefix'),
      npmCache: npmCache ?? join(cezarHomeDir(), 'dry-cache'), npmBin: npm?.npmBin, home: cezarHomeDir(), targetVersion: () => update.latest,
      dryRun: process.env.CEZ_DRY_RUN === '1',
      armRestart: (plan) => armRestartHelper(plan, { repoRoot, ...restartEndpoint(getServer().address()), npmBin: npm?.npmBin ?? 'npm' }),
      handoff: () => { void getServer().shutdownForRestart().then(() => process.exit(0)); },
    }) : undefined;
}

export function printServeBanner(
  version: string,
  repoRoot: string,
  repo: Awaited<ReturnType<typeof getRepoInfo>>,
  checks: Awaited<ReturnType<typeof detectEnvironment>>,
  url: string,
): void {
  console.log(`\n  cezar v${version} — ${repoRoot}`);
  console.log(`  ${repo ? `branch ${repo.branch}` : 'not a git repository (tasks run in place, one at a time; repo view is empty)'}`);
  for (const check of checks) {
    const mark = check.available ? '✓' : '✗';
    const detail = check.available ? (check.version ?? 'ok') : (check.hint ?? 'missing');
    console.log(`  ${mark} ${check.name.padEnd(6)} ${detail}`);
  }
  console.log(`\n  cockpit → ${url}\n`);
}
