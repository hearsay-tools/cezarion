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

/** Fresh real cockpit and output buffer for every case, including table rows. */
export function taskCliFixture() {
  let harness: TestCockpit;
  let store: RunStore;
  let manager: RunManager;
  let cockpit: Cockpit;
  let out: string[];
  let discoveries: number;

  beforeEach(async () => {
    harness = await startTestCockpit();
    ({ store, manager, cockpit } = harness);
    out = [];
    discoveries = 0;
  });

  afterEach(() => harness.close());

  const io = (stdin = ''): TaskIo => ({
    stdout: (line) => out.push(line),
    stdin: async () => stdin,
    discover: async () => { discoveries += 1; return cockpit; },
    open: () => {},
  });
  const run = (argv: string[], stdin?: string) => runTaskCommand(argv, {}, io(stdin));
  /** Register the harness repo with a task webhook (#589); CEZ_HOME is a per-worker sandbox. */
  const withWebhook = async () => {
    const entry = await registerProject(harness.repoRoot, undefined, testHome());
    await mergeWriteWorkspaceConfig((config) => {
      const found = config.projects.find((p) => p.id === entry.id)!;
      found.webhook = { url: 'https://bot.example/hook', token: 't' };
    }, testHome());
  };
  const last = () => JSON.parse(out.at(-1) ?? 'null') as Record<string, unknown>;
  const start = async (task = 'do the thing') => {
    expect(await run(['start', task])).toBe(0);
    return last().id as string;
  };
  /** A delegated worker owned by `parentId`, as the delegation layer creates one (#635). */
  const worker = (parentId: string) => {
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

  return {
    get harness() { return harness; },
    get store() { return store; },
    get manager() { return manager; },
    get cockpit() { return cockpit; },
    get out() { return out; },
    get discoveries() { return discoveries; },
    io, run, last, start, worker, withWebhook,
  };
}
