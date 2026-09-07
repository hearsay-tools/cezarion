import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { CredentialRegistry, type Caller } from './credentials.ts';
import { DelegationService } from './service.ts';

export function fixture(): { root: string; sha: string; store: RunStore; manager: RunManager; parent: RunRecord; credentials: CredentialRegistry; caller: Caller; token: string; service: DelegationService; close(): void } {
  const root = mkdtempSync(join(tmpdir(), 'cez-delegation-service-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
  const manager = new RunManager(store, root);
  // Scheduler admission is deliberately held: service acceptance must be durable before it.
  vi.spyOn(manager as unknown as { pump(): Promise<void> }, 'pump').mockResolvedValue();
  const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', runner: 'claude', model: 'opus', effort: 'high', steps: [] });
  store.updateRun(parent.id, { status: 'running', worktreePath: root, delegation: { role: 'root', permissions: ['spawn', 'inspect', 'steer', 'stop', 'destroy', 'diff', 'wait'], receipts: [] } });
  const credentials = new CredentialRegistry();
  const token = credentials.issue('project', parent.id, randomUUID());
  const caller = credentials.authenticate(token)!;
  vi.spyOn(manager, 'delegationExecutionSettings').mockReturnValue({ cwd: root, runner: 'claude', model: 'opus', effort: 'high', agentProfile: 'default', accountBinding: { provider: 'claude', profileId: 'default', homePath: root, claudeLayout: { kind: 'relocated' } } });
  const service = new DelegationService();
  service.registerProject({ id: 'project', root, store, manager });
  return { root, sha, store, manager, parent, credentials, caller, token, service,
    close() { credentials.close(); manager.dispose(); store.flush(); rmSync(root, { recursive: true, force: true }); } };
}
