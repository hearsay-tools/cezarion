import { createFixtureManager, drainFixtureManagers } from '../workflows/fixture-cleanup.testkit.ts';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { CredentialRegistry, type Caller } from './credentials.ts';
import { DelegationService } from './service.ts';

export async function waitForOwnedWork(manager: RunManager, store: RunStore): Promise<void> {
  // Root runs have no worker execution proof; fixture tracking drains those.
  for (const run of store.listRuns().filter(run => run.delegation?.role === 'worker' && manager.isActive(run.id))) {
    manager.cancel(run.id);
    if (!await manager.awaitRunTermination(run.id, 8_000)) throw new Error(`Worker did not terminate: ${run.id}`);
  }
}

export async function removeAfterOwnedWork(root: string, ownedWork: Promise<void>): Promise<void> {
  await ownedWork;
  rmSync(root, { recursive: true, force: true });
}

export function fixture(): { root: string; sha: string; store: RunStore; manager: RunManager; parent: RunRecord; credentials: CredentialRegistry; caller: Caller; token: string; service: DelegationService; close(): Promise<void> } {
  const root = mkdtempSync(join(tmpdir(), 'cez-delegation-service-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  // Auto-gc detaches after commit and writes into `.git` while recursive removal walks it.
  execFileSync('git', ['config', 'gc.auto', '0'], { cwd: root });
  execFileSync('git', ['config', 'maintenance.auto', 'false'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
  const manager = createFixtureManager(store, root);
  // Scheduler admission is deliberately held: service acceptance must be durable before it.
  vi.spyOn(manager as unknown as { pump(): Promise<void> }, 'pump').mockResolvedValue();
  const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', runner: 'claude', model: 'opus', effort: 'high', steps: [] });
  store.updateRun(parent.id, { status: 'running', worktreePath: root, delegation: { role: 'root', permissions: ['spawn', 'inspect', 'steer', 'stop', 'destroy', 'diff', 'wait'], receipts: [] } });
  const credentials = new CredentialRegistry();
  const token = credentials.issue('project', parent.id, randomUUID());
  const caller = credentials.authenticate(token)!;
  vi.spyOn(manager, 'delegationExecutionSettings').mockReturnValue({ cwd: root, runner: 'claude', model: 'opus', effort: 'high', agentProfile: 'default', accountBinding: { provider: 'claude', profileId: 'default', homePath: root, claudeLayout: { kind: 'relocated' } } });
  const service = new DelegationService();
  const unregister = service.registerProject({ id: 'project', root, store, manager });
  return { root, sha, store, manager, parent, credentials, caller, token, service,
    async close() {
      unregister();
      credentials.close();
      await removeAfterOwnedWork(root, waitForOwnedWork(manager, store).then(() => drainFixtureManagers(root)));
    } };
}
