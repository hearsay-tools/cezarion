import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '../runs/store.ts';
import { autosaveCleanupBlocker } from '../autosave-cleanup.ts';
import { runCheckout, type RunCheckoutHost } from './run-checkout.ts';

vi.mock('../autosave-cleanup.ts', () => ({ autosaveCleanupBlocker: vi.fn() }));

const root = mkdtempSync(join(tmpdir(), 'cez-run-checkout-'));
const live = join(root, 'live');
const gone = join(root, 'gone');
mkdirSync(live);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const baseRun: RunRecord = {
  id: '43d2b279-0dd9-49b5-aecb-1060c3020b9b', title: 'checkout', workflow: 'quick-task',
  task: 'read', status: 'done', createdAt: '2026-11-10T00:00:00Z', tokensUsed: 0,
  archived: false, steps: [],
};
const notFound = { status: 404, body: { error: 'not found' } };
const noWorktree = { status: 409, body: { error: 'no worktree — this task ran directly in the repo working tree' } };
const autosave = { status: 409, body: { error: 'autosave cleanup pending' } };

// One policy row for each Table A read route. Other intents join this table in later slices.
const routes = [
  { route: 'diff', checksAutosave: true, directory: 'existing-worktree', column: 'diff' },
  { route: 'changes', checksAutosave: true, directory: 'working-directory', column: 'working' },
  { route: 'commits', checksAutosave: false, directory: 'working-directory', column: 'working' },
  { route: 'commit/:sha', checksAutosave: false, directory: 'working-directory', column: 'working' },
  { route: 'files', checksAutosave: false, directory: 'working-directory', column: 'working' },
  { route: 'file-link', checksAutosave: false, directory: 'recorded-path-or-root', column: 'fileLink' },
] as const;
type Expected = string | null | typeof notFound;
interface State {
  name: string;
  run: RunRecord | undefined;
  blocked: boolean;
  diff: Expected;
  working: Expected;
  fileLink: Expected;
}
const states: State[] = [
  { name: 'unknown', run: undefined, blocked: false, diff: notFound, working: notFound, fileLink: notFound },
  { name: 'live', run: { ...baseRun, worktreePath: live }, blocked: false, diff: live, working: live, fileLink: live },
  { name: 'worktree off', run: { ...baseRun, worktree: false }, blocked: false, diff: null, working: root, fileLink: root },
  { name: 'worktree off with recorded path', run: { ...baseRun, worktree: false, worktreePath: live }, blocked: false, diff: live, working: root, fileLink: live },
  { name: 'empty recorded path', run: { ...baseRun, worktreePath: '' }, blocked: false, diff: null, working: noWorktree, fileLink: '' },
  { name: 'no path', run: baseRun, blocked: false, diff: null, working: noWorktree, fileLink: root },
  { name: 'removed', run: { ...baseRun, worktreePath: gone }, blocked: false, diff: null, working: noWorktree, fileLink: gone },
  { name: 'reclaimed', run: { ...baseRun, worktreeReclaimedAt: '2026-11-10T01:00:00Z' }, blocked: false, diff: null, working: noWorktree, fileLink: root },
  { name: 'running', run: { ...baseRun, status: 'running', worktreePath: live }, blocked: false, diff: live, working: live, fileLink: live },
  { name: 'usage hold', run: { ...baseRun, status: 'waiting', autoResumeAt: '2026-11-11T00:00:00Z', worktreePath: live }, blocked: false, diff: live, working: live, fileLink: live },
  { name: 'autosave with live path', run: { ...baseRun, worktreePath: live }, blocked: true, diff: live, working: live, fileLink: live },
  { name: 'autosave with removed path', run: { ...baseRun, worktreePath: gone }, blocked: true, diff: null, working: noWorktree, fileLink: gone },
  { name: 'autosave with unknown id', run: undefined, blocked: true, diff: notFound, working: notFound, fileLink: notFound },
];

function fakeHost(run: RunRecord | undefined): RunCheckoutHost {
  const forbidden = () => { throw new Error('a read must not check ownership, claim or write'); };
  return {
    root,
    store: {
      getRun: vi.fn(() => run), sourceDataDir: vi.fn(() => join(root, 'source')),
      updateRun: forbidden, writeRefusal: forbidden, fallbackDeleteError: forbidden, canDeleteRun: forbidden,
    },
    manager: { isActive: forbidden, claimForPublish: forbidden, claimWorktreeReclaim: forbidden },
  };
}

describe.each(routes)('read $route', (route) => {
  it.each(states)('$name keeps admission order and directory policy', (state) => {
    const host = fakeHost(state.run);
    vi.mocked(autosaveCleanupBlocker).mockReset().mockReturnValue(state.blocked ? autosave.body.error : undefined);
    const result = runCheckout(host, baseRun.id, 'read', route);
    const checksAutosave = Boolean(state.run && route.checksAutosave);
    const expected = checksAutosave && state.blocked ? autosave : state[route.column];
    expect(result).toEqual(typeof expected === 'object' && expected !== null
      ? expected
      : { run: state.run, directory: expected });
    expect(host.store.getRun).toHaveBeenCalledExactlyOnceWith(baseRun.id);
    expect(autosaveCleanupBlocker).toHaveBeenCalledTimes(Number(checksAutosave));
    expect(host.store.sourceDataDir).toHaveBeenCalledTimes(Number(checksAutosave));
    if (checksAutosave) {
      expect(autosaveCleanupBlocker).toHaveBeenCalledWith(join(root, 'source'), baseRun.id);
    }
  });
});
