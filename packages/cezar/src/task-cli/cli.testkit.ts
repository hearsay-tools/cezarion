import { testHome } from '../home/test-home.testkit.ts';
import { randomUUID } from 'node:crypto';
import { STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { afterEach, beforeEach, expect } from 'vitest';
import type { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { startTestCockpit, type TestCockpit } from './cockpit.testkit.ts';
import { runTaskCommand, type TaskIo } from './cli.ts';
import type { Cockpit } from './http.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { registerProject } from '../workspace/projects.ts';

/**
 * `cez task` against a real cockpit app on a real socket (#504): the shared fixture of
 * `cli.test.ts` and `cli-operations.test.ts`. Each file calls `useTaskCliFixture()` inside its `cez task` describe;
 * the bindings below are live, so a test reads the current test's cockpit, store and output.
 */
export let harness: TestCockpit;
export let store: RunStore;
export let manager: RunManager;
export let cockpit: Cockpit;
export let out: string[];
export let discoveries: number;

export function useTaskCliFixture(): void {
  beforeEach(async () => {
    harness = await startTestCockpit();
    ({ store, manager, cockpit } = harness);
    out = [];
    discoveries = 0;
  });

  afterEach(() => harness.close());
}

export const io = (stdin = ''): TaskIo => ({
  stdout: (line) => out.push(line),
  stdin: async () => stdin,
  discover: async () => { discoveries += 1; return cockpit; },
  open: () => {},
});
export const run = (argv: string[], stdin?: string) => runTaskCommand(argv, {}, io(stdin));
/** Register the harness repo with a task webhook (#589); CEZ_HOME is a per-worker sandbox. */
export const withWebhook = async () => {
  const entry = await registerProject(harness.repoRoot, undefined, testHome());
  await mergeWriteWorkspaceConfig((config) => {
    const found = config.projects.find((p) => p.id === entry.id)!;
    found.webhook = { url: 'https://bot.example/hook', token: 't' };
  }, testHome());
};
export const last = () => JSON.parse(out.at(-1) ?? 'null') as Record<string, unknown>;
export const start = async (task = 'do the thing') => {
  expect(await run(['start', task])).toBe(0);
  return last().id as string;
};
/** A delegated worker owned by `parentId`, as the delegation layer creates one (#635). */
export const worker = (parentId: string) => {
  const workerId = randomUUID();
  if (!store.getRun(parentId)?.delegation) store.updateRun(parentId, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
  return store.createOwnedRun(
    { title: 'worker', task: 'worker', workflow: 'quick-task', runner: 'claude', steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] },
    parentId,
    randomUUID(),
    {
      role: 'worker', permissions: [], parentRunId: parentId,
      workspace: {
        ownerRunId: workerId, resourceId: randomUUID(), kind: 'owned-isolated',
        path: `/managed/${workerId}`, branch: `cez/${workerId.slice(0, 8)}`, baselineSha: 'a'.repeat(40),
      },
    },
    'a'.repeat(64),
  ).id;
};
