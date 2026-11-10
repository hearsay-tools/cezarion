import { existsSync } from 'node:fs';
import { autosaveCleanupBlocker } from '../autosave-cleanup.ts';
import type { RunManager } from '../workflows/run.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';

// ---- session git view (redesign R5 Step 1.2 — §"Git/session API additions").
// Structured sibling of the text-blob /diff above (which stays untouched —
// protected surface). Isolated runs read their worktree; worktree-off runs
// read the repo checkout they executed in. Every predictable git failure
// degrades to 409 + human-readable reason, 404 only for unknown ids.
export const worktreeOf = (run: RunRecord): string | null =>
  run.worktreePath && existsSync(run.worktreePath) ? run.worktreePath : null;
export const workingDirectoryOf = (run: RunRecord, repoRoot: string): string | null =>
  run.worktree === false
    ? repoRoot
    : worktreeOf(run);
export const NO_WORKTREE = 'no worktree — this task ran directly in the repo working tree';

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

/** Read admission is synchronous and never claims, adopts or rebuilds a checkout. */
export function runCheckout<Rule extends ReadDirectoryRule>(
  host: RunCheckoutHost,
  id: string,
  _intent: Extract<CheckoutIntent, 'read'>,
  options: ReadOptions<Rule>,
): CheckoutRefusal | ReadHandle<Rule>;
export function runCheckout(
  { root, store }: RunCheckoutHost,
  id: string,
  _intent: Extract<CheckoutIntent, 'read'>,
  options: ReadOptions<ReadDirectoryRule>,
): CheckoutRefusal | ReadHandle<ReadDirectoryRule> {
  const run = store.getRun(id);
  if (!run) return { status: 404, body: { error: 'not found' } };
  if (options.checksAutosave) {
    const blocker = autosaveCleanupBlocker(store.sourceDataDir(run.id), run.id);
    if (blocker) return { status: 409, body: { error: blocker } };
  }
  if (options.directory === 'recorded-path-or-root') {
    return { run, directory: run.worktreePath ?? root };
  }
  const directory = options.directory === 'existing-worktree' ? worktreeOf(run) : workingDirectoryOf(run, root);
  if (!directory && options.directory === 'working-directory') {
    return { status: 409, body: { error: NO_WORKTREE } };
  }
  return { run, directory };
}
