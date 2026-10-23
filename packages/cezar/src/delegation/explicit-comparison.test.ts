import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';
import { fixture } from './service.testkit.ts';
import { ensureOwnedWorkspace } from './workspace.ts';

let f: ReturnType<typeof fixture>;
beforeEach(() => { onTestFinished(scopeFixtureProcesses()); vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); });
afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=QA', '-c', 'user.email=qa@cezar.test', ...args], { encoding: 'utf8' }).trim();

it('keeps owned-worker comparison explicit from spawn through collection, integration and verified cleanup', async () => {
  const workers = [];
  for (const approach of ['minimal', 'structural']) {
    const accepted = await f.service.spawn(f.caller, { task: `Try ${approach}`, baseline: 'parent-head', requestId: randomUUID() });
    const worker = f.store.getRun(accepted.workerId)!;
    const generation = f.store.commitWorkerExecutionStart(worker.id);
    const workspace = await ensureOwnedWorkspace(f.root, worker);
    writeFileSync(join(workspace.path, 'approach.txt'), approach);
    git(workspace.path, 'add', 'approach.txt');
    git(workspace.path, 'commit', '-qm', approach);
    f.store.updateRun(worker.id, { status: 'done', finishedAt: new Date().toISOString() });
    expect(f.store.commitWorkerExecutionComplete(worker.id, generation)).toBe(true);
    workers.push({ id: worker.id, path: workspace.path, approach });
  }
  expect(workers[0]!.path).not.toBe(workers[1]!.path);
  const collected = [];
  for (const worker of workers) {
    const result = await f.service.collect(f.caller, { workerId: worker.id });
    expect(result.settled).toBe(true);
    expect(result.head.state).toBe('available');
    expect(result.diff.state).toBe('available');
    if (result.diff.state !== 'available') throw Error('missing diff');
    expect(JSON.parse(readFileSync(result.diff.path, 'utf8')).diffSnapshot).toContain(`+${worker.approach}`);
    expect((await f.service.diff(f.caller, { workerId: worker.id })).diff).toContain(`+${worker.approach}`);
    expect(existsSync(worker.path)).toBe(true);
    collected.push(result);
  }
  const chosen = collected[0]!;
  if (chosen.head.state !== 'available') throw Error('missing commit');
  git(f.root, 'cherry-pick', chosen.head.sha);
  expect(readFileSync(join(f.root, 'approach.txt'), 'utf8')).toBe('minimal');
  // Choosing a commit alone does not erase the other worker's result.
  expect(existsSync(workers[1]!.path)).toBe(true);
  for (const worker of workers) {
    expect(await f.service.destroy(f.caller, { workerId: worker.id })).toMatchObject({ state: 'complete', remaining: [] });
    expect(existsSync(worker.path)).toBe(false);
    expect(f.store.getRun(worker.id)).toBeDefined();
  }
  expect(git(f.root, 'log', '-1', '--format=%s')).toBe('minimal');
});
