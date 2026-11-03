import { runInternals } from '../workflows/run-internals.testkit.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSpec } from '../core/agent-runner.ts';
import { join } from 'node:path';
import { QUICK_TASK_WORKFLOW } from '../workflows/types.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import { agentHomePaths, claudeStateFilePath } from '../paths.ts';
import { buildChildEnv } from '../core/agent-env.ts';
import { provisionWorkflowFixture, delegationToken, until, PROVISION_ROWS } from './provision-workflows.testkit.ts';

// Git worktrees + a live RunManager contend under full-suite workers. until() is already 15s;
// the default 5s testTimeout / 10s hookTimeout cannot finish those waits. Teardown still cancels
// and finishes sessions without polling, then waits for owned work before removing the fixture.
describe('manager session delegation lifecycle', { timeout: 15_000 }, () => {
  const context = provisionWorkflowFixture();
  let f: typeof context.f, controller: typeof context.controller;
  const { sessions, acceptIdentityWorker, launchAccepted } = context;
  beforeEach(() => { f = context.f; controller = context.controller; });

  it.each(PROVISION_ROWS.inputRecipes)('rejects lost accepted input recipes on %s', async mode => {
    const a = await acceptIdentityWorker(undefined, undefined, { context: { text: 'accepted context' } });
    if (mode === 'continue') {
      await launchAccepted(a, mode); await until(() => sessions.length === 2);
      sessions[1]!.finish(); expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    }
    const worker = f.store.getRun(a.child.workerId)!;
    if (worker.delegation?.role !== 'worker') throw Error('worker');
    const { context: _context, ...delegation } = worker.delegation;
    f.store.commitDelegation([{ id: worker.id, delegation }]);
    if (mode === 'continue') expect(f.manager.continueRun(worker.id, { text: 'again' })).toMatchObject({ ok: false, error: expect.stringContaining('context') });
    else {
      const { store } = await launchAccepted(a, mode);
      await until(() => store.getRun(worker.id)?.status === 'failed' || sessions.length > 1);
      expect(store.getRun(worker.id)).toMatchObject({ status: RUN_STATUS.failed, error: expect.stringContaining('context') });
    }
    expect(sessions).toHaveLength(mode === 'continue' ? 2 : 1);
  });
  it.each(PROVISION_ROWS.contextArtifacts)('verifies or rebuilds explicit context with $damage on $mode', async ({ mode, damage }) => {
    let original = '';
    const a = await acceptIdentityWorker(undefined, undefined, { context: { artifacts: [{ kind: 'parent-attachment', id: 'document.txt' }] } }, parentId => {
      const dir = join(f.root, '.ai/cezar/runs', `${parentId}-images`); mkdirSync(dir);
      original = join(dir, 'document.txt'); writeFileSync(original, 'accepted document');
    });
    const inspected = await controller.service.inspect(a.caller, { workerId: a.child.workerId });
    const copy = inspected.inputs![0]!.path;
    if (mode === 'continue') {
      await launchAccepted(a, mode); await until(() => sessions.length === 2);
      sessions[1]!.finish(); expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    }
    if (damage === 'original-deleted') rmSync(original);
    else { rmSync(copy); if (damage === 'both-changed') writeFileSync(original, 'replaced document'); }
    let store = f.store;
    if (mode === 'continue') expect(f.manager.continueRun(a.child.workerId, { text: 'again' }).ok).toBe(true);
    else ({ store } = await launchAccepted(a, mode));
    const expectedSessions = mode === 'continue' ? 3 : 2;
    if (damage === 'both-changed') {
      await until(() => store.getRun(a.child.workerId)?.status === 'failed' || sessions.length === expectedSessions);
      expect(store.getRun(a.child.workerId)).toMatchObject({ status: RUN_STATUS.failed, error: expect.stringContaining('context input') });
      expect(sessions).toHaveLength(expectedSessions - 1);
    } else {
      await until(() => sessions.length === expectedSessions);
      expect(readFileSync(copy, 'utf8')).toBe('accepted document');
    }
  });
  async function acceptClaudeLayout(layout: 'native' | 'override' | 'named') {
    const nativeHome = join(f.root, 'native-home'); const home = join(nativeHome, '.claude'); mkdirSync(home, { recursive: true });
    vi.stubEnv('HOME', nativeHome); vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    if (layout === 'override') vi.stubEnv('CLAUDE_CONFIG_DIR', home);
    if (layout === 'named') {
      const discovered = join(f.root, 'other-claude'); mkdirSync(discovered); vi.stubEnv('CLAUDE_CONFIG_DIR', discovered);
      await mergeWriteAgentAccounts(store => { store.accounts = [{ id: 'named-native-dir', provider: 'claude', configDir: home, label: '', addedAt: '' }]; });
    }
    const parent = f.manager.startRun(QUICK_TASK_WORKFLOW, { task: 'parent', runner: 'claude', worktree: false, ...(layout === 'named' ? { agentProfile: 'named-native-dir' } : {}) });
    await until(() => sessions.length === 1);
    const caller = controller.credentials.authenticate(delegationToken(sessions[0]!.spec))!;
    const pump = vi.spyOn(runInternals(f.manager).line, 'pump').mockResolvedValue();
    const request = { task: 'child', baseline: 'HEAD', requestId: randomUUID() };
    const child = await controller.service.spawn(caller, request);
    expect(pump).toHaveBeenCalled();
    return { home, nativeHome, parent, caller, pump, request, child };
  }
  function claudeState(spec: AgentRunSpec) {
    const env = buildChildEnv({ backend: 'claude', extraEnv: spec.env });
    return claudeStateFilePath(agentHomePaths(env).claude, env);
  }
  it.each(PROVISION_ROWS.claudeLayout)('preserves Claude $layout state-file layout on $mode', async ({ mode, layout }) => {
    const a = await acceptClaudeLayout(layout);
    const expectedState = layout === 'native' ? join(a.nativeHome, '.claude.json') : join(a.home, '.claude.json');
    expect(claudeState(sessions[0]!.spec)).toBe(expectedState);
    await launchAccepted(a, mode); await until(() => sessions.length === 2);
    if (mode === 'continue') {
      sessions[1]!.finish(); expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
      expect(f.manager.continueRun(a.child.workerId, { text: 'again' }).ok).toBe(true); await until(() => sessions.length === 3);
    }
    const worker = sessions.at(-1)!;
    expect(claudeState(worker.spec)).toBe(expectedState);
    expect(worker.spec.env?.CLAUDE_CONFIG_DIR).toBe(layout === 'native' ? undefined : a.home);
  });
  it.each(PROVISION_ROWS.claudeEnvironment)('refuses incompatible native Claude $change environment on $mode', async ({ mode, change }) => {
    const a = await acceptClaudeLayout('native');
    if (mode === 'continue') {
      await launchAccepted(a, mode); await until(() => sessions.length === 2);
      sessions[1]!.finish(); expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    }
    if (change === 'same-dir-override') vi.stubEnv('CLAUDE_CONFIG_DIR', a.home);
    else {
      const other = join(f.root, 'changed-home'); mkdirSync(other);
      if (change === 'other-override') vi.stubEnv('CLAUDE_CONFIG_DIR', other);
      else { symlinkSync(a.home, join(other, '.claude'), 'dir'); vi.stubEnv('HOME', other); }
    }
    if (mode === 'continue') expect(f.manager.continueRun(a.child.workerId, { text: 'again' })).toMatchObject({ ok: false, error: expect.stringContaining('layout') });
    else {
      const { store } = await launchAccepted(a, mode);
      await until(() => store.getRun(a.child.workerId)?.status === 'failed' || sessions.length > 1);
      expect(store.getRun(a.child.workerId)).toMatchObject({ status: RUN_STATUS.failed, error: expect.stringContaining('layout') });
    }
    expect(sessions).toHaveLength(mode === 'continue' ? 2 : 1);
  });
  it('checks native Claude layout against merged session env, not only the host env', async () => {
    const a = await acceptClaudeLayout('native');
    const engine = f.manager as unknown as { agentEnv(...args: unknown[]): Record<string, string> };
    const prepare = engine.agentEnv.bind(f.manager);
    vi.spyOn(engine, 'agentEnv').mockImplementation((...args) => ({ ...prepare(...args), CLAUDE_CONFIG_DIR: a.home }));
    const { store } = await launchAccepted(a, 'queued');
    await until(() => store.getRun(a.child.workerId)?.status === 'failed' || sessions.length > 1);
    expect(store.getRun(a.child.workerId)).toMatchObject({ status: RUN_STATUS.failed, error: expect.stringContaining('layout') }); expect(sessions).toHaveLength(1);
  });
  it.each(PROVISION_ROWS.privateLayout)('refuses missing private Claude layout evidence on %s', async mode => {
    const a = await acceptClaudeLayout('native');
    if (mode === 'continue') {
      await launchAccepted(a, mode); await until(() => sessions.length === 2);
      sessions[1]!.finish(); expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    }
    const path = join(f.root, '.ai/cezar/runs', `${a.child.workerId}.identity.json`);
    const evidence = JSON.parse(readFileSync(path, 'utf8')) as { account: { claudeLayout?: unknown } };
    delete evidence.account.claudeLayout; writeFileSync(path, JSON.stringify(evidence));
    if (mode === 'continue') expect(f.manager.continueRun(a.child.workerId, { text: 'again' })).toMatchObject({ ok: false, error: expect.stringContaining('identity') });
    else {
      const { store } = await launchAccepted(a, mode);
      await until(() => store.getRun(a.child.workerId)?.status === 'failed' || sessions.length > 1);
      expect(store.getRun(a.child.workerId)).toMatchObject({ status: RUN_STATUS.failed, error: expect.stringContaining('identity') });
    }
    expect(sessions).toHaveLength(mode === 'continue' ? 2 : 1);
  });
  it('keeps ordinary native Claude state-file discovery unchanged while delegation is off', async () => {
    const home = join(f.root, 'ordinary-home'); mkdirSync(join(home, '.claude'), { recursive: true });
    vi.stubEnv('HOME', home); vi.stubEnv('CLAUDE_CONFIG_DIR', undefined); vi.stubEnv('CEZ_DELEGATION', '0');
    const run = f.manager.startRun(QUICK_TASK_WORKFLOW, { task: 'ordinary', runner: 'claude', worktree: false });
    await until(() => sessions.length === 1);
    expect(claudeState(sessions[0]!.spec)).toBe(join(home, '.claude.json')); expect(sessions[0]!.spec.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(f.store.getRun(run.id)?.delegation).toBeUndefined();
    sessions[0]!.finish(); await until(() => !f.manager.isActive(run.id));
    expect(f.manager.continueRun(run.id, { text: 'again' }).ok).toBe(true); await until(() => sessions.length === 2);
    expect(claudeState(sessions[1]!.spec)).toBe(join(home, '.claude.json')); expect(f.store.getRun(run.id)?.delegation).toBeUndefined();
  });
});
