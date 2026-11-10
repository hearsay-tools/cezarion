import { engineOwnsRun } from '@open-mercato/cezar-contract/run-predicates';
import { isUsageLimitHold } from '@open-mercato/cezar-contract/waits';
import { fallbackProjectWriteError } from '../project-paths.ts';
import { rematerializeReclaimedWorktree } from '../runs/retention.ts';
import { getStatus } from './git.ts';
import { existsSync } from 'node:fs';
import { autosaveCleanupBlocker } from '../autosave-cleanup.ts';
import type { RunManager } from '../workflows/run.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';

// ---- session git view (redesign R5 Step 1.2 — §"Git/session API additions").
// Structured sibling of the text-blob /diff route in server.ts (which stays untouched —
// protected surface). Isolated runs read their worktree; worktree-off runs
// read the repo checkout they executed in. Every predictable git failure
// degrades to 409 + human-readable reason, 404 only for unknown ids.
const worktreeOf = (run: RunRecord): string | null =>
  run.worktreePath && existsSync(run.worktreePath) ? run.worktreePath : null;
const workingDirectoryOf = (run: RunRecord, repoRoot: string): string | null =>
  run.worktree === false
    ? repoRoot
    : worktreeOf(run);
const NO_WORKTREE = 'no worktree — this task ran directly in the repo working tree';

export type CheckoutIntent = 'read' | 'mutate' | 'publish' | 'remove' | 'open';
export interface RunCheckoutHost {
  root: string;
  store: Pick<RunStore, 'getRun' | 'updateRun' | 'sourceDataDir' | 'writeRefusal' | 'fallbackDeleteError' | 'canDeleteRun'>;
  manager: Pick<RunManager, 'isActive' | 'claimForPublish' | 'claimWorktreeReclaim'>;
}

type ReadDirectoryRule = 'working-directory' | 'existing-worktree' | 'recorded-path-or-root';
interface ReadOptions<Rule extends ReadDirectoryRule> {
  checksAutosave: boolean;
  directory: Rule;
}
type CheckoutRefusal = { status: 404 | 409; body: { error: string } };
type ReadHandle<Rule extends ReadDirectoryRule> = {
  run: RunRecord;
  directory: Rule extends 'existing-worktree' ? string | null : string;
};

interface OpenOptions {
  ignoresEngineOwnership: boolean;
  defaultTargetNeedsWorktree: boolean;
}
type OpenHandle = {
  run: RunRecord;
  directory: () => string;
  readonly worktree: string | null;
  defaultWorktree: () => string | CheckoutRefusal;
  readonly resumeAllowed: boolean;
};

type ClaimedHandle = { run: RunRecord; release: () => void };
interface RemoveOptions {
  claim: 'publish' | 'reclaim';
  activeBeforeLookup: boolean;
  checksActive: boolean;
  deletion: 'worktree' | 'record' | 'inline';
  nullClaimError: string;
}

export function runCheckout(host: RunCheckoutHost, id: string, intent: 'open', options: OpenOptions): CheckoutRefusal | OpenHandle;
/** Admission stays synchronous: no yield between lookup and claim. */
export function runCheckout(host: RunCheckoutHost, id: string, intent: 'publish'): CheckoutRefusal | ClaimedHandle;
export function runCheckout(host: RunCheckoutHost, id: string, intent: 'remove', options: RemoveOptions): CheckoutRefusal | ClaimedHandle;
export function runCheckout<Rule extends ReadDirectoryRule>(
  host: RunCheckoutHost,
  id: string,
  _intent: Extract<CheckoutIntent, 'read'>,
  options: ReadOptions<Rule>,
): CheckoutRefusal | ReadHandle<Rule>;
export function runCheckout(
  host: RunCheckoutHost,
  id: string,
  intent: Extract<CheckoutIntent, 'mutate'>,
): CheckoutRefusal | ReadHandle<'working-directory'>;
export function runCheckout(
  host: RunCheckoutHost,
  id: string,
  intent: CheckoutIntent,
  options: ReadOptions<ReadDirectoryRule> | RemoveOptions | OpenOptions = { checksAutosave: true, directory: 'existing-worktree' },
): CheckoutRefusal | ReadHandle<ReadDirectoryRule> | ClaimedHandle | OpenHandle {
  if (intent === 'publish') return publishCheckout(host, id);
  if ('ignoresEngineOwnership' in options) return openCheckout(host, id, options);
  if ('claim' in options) return removeCheckout(host, id, options);
  const { root, store } = host;
  const run = store.getRun(id);
  if (!run) return { status: 404, body: { error: 'not found' } };
  const refusal = intent === 'mutate' && run.worktreePath && fallbackProjectWriteError(run.worktreePath);
  if (refusal) return { status: 409, body: { error: refusal } };
  if (options.checksAutosave) {
    const blocker = autosaveCleanupBlocker(store.sourceDataDir(run.id), run.id);
    if (blocker) return { status: 409, body: { error: blocker } };
  }
  if (options.directory === 'recorded-path-or-root') {
    return { run, directory: run.worktreePath ?? root };
  }
  const directory = options.directory === 'existing-worktree' ? worktreeOf(run) : workingDirectoryOf(run, root);
  if (!directory && (intent === 'mutate' || options.directory === 'working-directory')) {
    return { status: 409, body: { error: NO_WORKTREE } };
  }
  return { run, directory };
}

function publishCheckout({ store, manager }: RunCheckoutHost, id: string): CheckoutRefusal | ClaimedHandle {
  const held = store.getRun(id);
  if (!held) return { status: 404, body: { error: 'not found' } };
  const refusal = held.worktreePath && fallbackProjectWriteError(held.worktreePath);
  if (refusal) return { status: 409, body: { error: refusal } };
  if (manager.isActive(id)) return { status: 409, body: { error: 'run is still active — wait for the review gate' } };
  // A hold is live: done would drop its resume (S7 B13). Don’t resume (DELETE …/auto-resume) settles it failed.
  if (isUsageLimitHold(held)) return { status: 409, body: { error: 'run is waiting on a usage-limit hold — choose Don’t resume in the task’s usage-limit hint, then retry Draft PR' } };
  const release = manager.claimForPublish(id);
  if (!release) return { status: 409, body: { error: 'its worktree or branch is being cleaned up — retry in a moment' } };
  return { run: held, release };
}

/** The caller holds publish admission's claim until all publish work finishes. */
export async function preparePublishCheckout({ root, store }: RunCheckoutHost, id: string): Promise<
  CheckoutRefusal | { run: RunRecord }
> {
  // Reclaim (open-mercato/cezar#483, issue 08 §B4) removed the directory and kept the branch, and Not landed
  // offers this on exactly those rows: restore the checkout first, as Continue does.
  await rematerializeReclaimedWorktree(root, store, id);
  const run = store.getRun(id);
  if (!run) return { status: 404, body: { error: 'not found' } };
  if (!run.worktreePath || !existsSync(run.worktreePath) || !run.branch) {
    return { status: 409, body: { error: 'no worktree/branch to publish — this task ran in the repo working tree' } };
  }
  return { run };
}

function removalRefusal(store: RunCheckoutHost['store'], run: RunRecord, id: string, deletion: RemoveOptions['deletion']): string | undefined {
  if (deletion === 'inline') return store.fallbackDeleteError(run.id, 'worktree') ?? store.writeRefusal(run.id);
  if (deletion === 'worktree') {
    if (!store.canDeleteRun(id, 'worktree') || run.delegation?.role === 'worker') return 'owned resources require verified worker cleanup';
  } else {
    // Delete cleans up after itself: worktree + branch go with the run (spec 006).
    if (!store.canDeleteRun(id)) return 'owned resources require verified worker cleanup and explicit child history deletion first';
  }
  return undefined;
}

function removeCheckout({ store, manager }: RunCheckoutHost, id: string, options: RemoveOptions): CheckoutRefusal | ClaimedHandle {
  const active = { status: 409, body: { error: 'run is active — cancel it first' } } as const;
  if (options.checksActive && options.activeBeforeLookup && manager.isActive(id)) return active;
  const run = store.getRun(id);
  if (!run) return { status: 404, body: { error: 'not found' } };
  if (options.checksActive && !options.activeBeforeLookup && manager.isActive(id)) return active;
  const refused = removalRefusal(store, run, id, options.deletion);
  if (refused) return { status: 409, body: { error: refused } };
  if (isUsageLimitHold(run)) return { status: 409, body: { error: 'run is waiting on a usage-limit hold — choose Don’t resume in the task’s usage-limit hint, then retry' } };
  // Claimed, not merely checked: the claim holds Continue off until the directory is gone.
  const release = options.claim === 'reclaim' ? manager.claimWorktreeReclaim(run.id) : manager.claimForPublish(id);
  if (!release) return { status: 409, body: { error: options.nullClaimError } };
  return { run, release };
}

/** Reclaim calls this only after reclaimWorktree(...).finally(release) settles. */
export async function reclaimCheckoutError(run: RunRecord): Promise<string> {
  // Reclaim keeps only what is committed, so it leaves a dirty checkout alone; say which case this was.
  const dirty = run.worktreePath && existsSync(run.worktreePath) ? (await getStatus(run.worktreePath).catch(() => [])).length : 0;
  return dirty > 0
    ? `the worktree has ${dirty} uncommitted file${dirty === 1 ? '' : 's'} that exist nowhere else — commit or discard them first`
    : 'the worktree directory could not be removed';
}

function openCheckout({ root, store }: RunCheckoutHost, id: string, options: OpenOptions): CheckoutRefusal | OpenHandle {
  const run = store.getRun(id);
  if (!run) return { status: 404, body: { error: 'not found' } };
  return {
    run,
    directory: () => worktreeOf(run) ?? root,
    get worktree() { return worktreeOf(run); },
    defaultWorktree() {
      const worktree = worktreeOf(run);
      return worktree ?? (options.defaultTargetNeedsWorktree ? { status: 409, body: { error: NO_WORKTREE } } : root);
    },
    get resumeAllowed() { return options.ignoresEngineOwnership || !engineOwnsRun(run); },
  };
}
