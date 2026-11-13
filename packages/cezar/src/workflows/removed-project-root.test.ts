import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { AgentRunSpec, AgentRunner } from '../core/agent-runner.ts';

import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { projectMovedMarker, projectPaths } from '../project-paths.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { createFixtureManager, drainFixtureManagers, fixtureWorkSettled } from './fixture-manager.testkit.ts';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await drainFixtureManagers(join(root, 'current'));
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['Continue', 'recovery'])('%s uses the current repo after its old root is removed', async entry => {
  const scratch = mkdtempSync(join(tmpdir(), 'cez-removed-root-'));
  roots.push(scratch);
  const oldRoot = join(scratch, 'old');
  const current = join(scratch, 'current');
  mkdirSync(oldRoot);
  execFileSync('git', ['init', '-q', '-b', 'main', oldRoot]);
  const oldData = join(oldRoot, '.ai/cezar');
  mkdirSync(oldData, { recursive: true });
  const source = RunStore.open(oldData, { keepLive: true });
  const title = entry === 'Continue' ? 'manual' : 'recovery';
  const run = source.createRun({ title, task: 'continue in the current repository', workflow: 'quick-task', steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] });
  source.updateRun(run.id, { worktreePath: join(oldData, 'worktrees', run.id) });
  source.updateStep(run.id, 'task', { status: STEP_STATUS.running, backend: 'claude', sessionId: `session-${title}` });
  setRunStatus(source, run.id, title === 'manual' ? RUN_STATUS.failed : RUN_STATUS.running);
  source.close();
  renameSync(oldRoot, current);
  const store = RunStore.open(projectPaths(current).write, { keepLive: true });
  const specs: AgentRunSpec[] = [];
  const runner: AgentRunner = {
    backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: spec => {
      specs.push(spec);
      return { result: Promise.resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 }), sendMessage: () => false,
        sendAgentMessage: () => false, discardQueuedMessages: () => {}, holdsHumanInput: () => false, end: () => {}, interrupt: () => {}, open: false };
    },
    interrupt: async () => {},
  };
  const manager = createFixtureManager(store, current, { createRunner: () => runner });
  if (entry === 'Continue') expect(manager.continueRun(run.id, { text: 'continue' })).toEqual({ ok: true });
  else await manager.recover();
  await fixtureWorkSettled(current);
  expect(specs.map(spec => spec.cwd)).toEqual([current]);
  expect(specs.map(spec => spec.sessionId)).toEqual([`session-${title}`]);
  expect(existsSync(oldRoot)).toBe(false);
});

it.each([false, true])('still refuses a legacy checkout inside a real migrated project (checkout exists=%s)', checkoutExists => {
  const scratch = mkdtempSync(join(tmpdir(), 'cez-existing-root-'));
  roots.push(scratch);
  const current = join(scratch, 'current');
  mkdirSync(current);
  execFileSync('git', ['init', '-q', current]);
  const marker = projectMovedMarker(current)!;
  mkdirSync(join(current, '.git/cezar-moved-projects'), { recursive: true });
  writeFileSync(marker.path, JSON.stringify({ root: marker.root }));
  const store = RunStore.open(projectPaths(current).write, { keepLive: true });
  const run = store.createRun({ title: 'legacy', task: 'keep read only', workflow: 'quick-task', steps: [] });
  const worktreePath = join(current, '.ai/cezar/worktrees', run.id);
  if (checkoutExists) mkdirSync(worktreePath, { recursive: true });
  store.updateRun(run.id, { worktreePath });
  setRunStatus(store, run.id, RUN_STATUS.failed);
  const manager = createFixtureManager(store, current, { createRunner: () => { throw new Error('must not launch'); } });
  expect(manager.continueRun(run.id)).toEqual({ ok: false, error: expect.stringContaining('Cannot write read-only project data') });
});
