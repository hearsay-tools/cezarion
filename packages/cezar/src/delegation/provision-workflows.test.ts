import { type WorkerSpawnRequest, workerDiffSchema, workerWaitResultSchema } from '@open-mercato/cezar-contract';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import type { AgentRunResult, AgentRunSpec, AgentSession, AgentEvent } from '../core/agent-runner.ts';
import * as runners from '../core/runner-factory.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { RunStore } from '../runs/store.ts';
import { join } from 'node:path';
import { planOwnedWorkspace } from './workspace.ts';
import { fixture, waitForOwnedWork } from './service.testkit.ts';
import { DelegationController } from './provision.ts';
import { QUICK_TASK_WORKFLOW } from '../workflows/types.ts';
import { mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import { RunManager } from '../workflows/run.ts';
import { agentHomePaths, claudeStateFilePath } from '../paths.ts';
import { buildChildEnv } from '../core/agent-env.ts';
import { ProjectContexts } from '../server/project-context.ts';

const until = (predicate: () => boolean) => vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 15000, interval: 10 });
// Git worktrees + a live RunManager contend under full-suite workers. until() is already 15s;
// the default 5s testTimeout / 10s hookTimeout cannot finish those waits. Teardown still cancels
// and finishes sessions without polling, then waits for owned work before removing the fixture.
describe('manager session delegation lifecycle', { timeout: 15_000 }, () => {
  let f: ReturnType<typeof fixture>, controller: DelegationController;
  const recoveredManagers: RunManager[] = [];
  const recoveredStores: RunStore[] = [];
  const sessions: Array<{ spec: AgentRunSpec; session: AgentSession; emit(event: AgentEvent): void; finish(text?: string): void }> = [];
  beforeEach(async () => {
    vi.stubEnv('CEZ_DELEGATION', '1'); vi.stubEnv('CEZ_DRY_RUN', '1'); vi.stubEnv('CEZ_AUTONAME', '0');
    f = fixture(); vi.restoreAllMocks();
    const home = join(f.root, 'default-claude'); mkdirSync(home); vi.stubEnv('CLAUDE_CONFIG_DIR', home);
    vi.spyOn(runners, 'createRunner').mockImplementation(backend => ({ backend: backend ?? 'claude', specSupport: CLAUDE_SPEC_SUPPORT, interrupt: async () => {}, run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), startSession: (spec, emit) => {
      let resolve!: (value: AgentRunResult) => void; let open = true;
      const result = new Promise<AgentRunResult>(done => { resolve = done; });
      const finish = (text = '') => { open = false; resolve({ text, toolCalls: [], tokensUsed: 0 }); };
      const session: AgentSession = { result, get open() { return open; }, sendMessage: () => open, sendAgentMessage: () => open ? Promise.resolve() : false, discardQueuedMessages: () => {}, interrupt: finish, end: finish };
      sessions.push({ spec, session, emit: event => emit?.(event), finish }); return session;
    } }));
    controller = await DelegationController.start(); controller.attachProject({ id: 'project', root: f.root, manager: f.manager, store: f.store });
  });
  afterEach(async () => {
    for (const manager of recoveredManagers) {
      for (const run of f.store.listRuns()) manager.cancel(run.id);
    }
    for (const run of f.store.listRuns()) f.manager.cancel(run.id);
    for (const s of sessions) s.finish();
    for (const manager of recoveredManagers) {
      await waitForOwnedWork(manager, f.store);
      manager.dispose();
    }
    recoveredManagers.length = 0;
    for (const store of recoveredStores) store.flush(); recoveredStores.length = 0;
    await controller.close(); sessions.length = 0; await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  });
  // Real acceptance/store/manager and account registry; only the external agent wire is fake.
  async function acceptIdentityWorker(settings: { model?: string; effort?: string } = { model: 'haiku', effort: 'high' }, grants?: { allowedTools: string[]; bashAllowlist: string[] }, spawnInputs: Pick<WorkerSpawnRequest, 'context' | 'backend' | 'model' | 'workflow'> = {}, prepare?: (parentId: string) => void) {
    const home = join(f.root, 'account-a'); mkdirSync(home);
    await mergeWriteAgentAccounts(store => { store.accounts = [{ id: 'account-a', provider: 'claude', configDir: home, label: 'A', addedAt: '' }]; });
    const workflow = grants ? { ...QUICK_TASK_WORKFLOW, steps: [{ ...QUICK_TASK_WORKFLOW.steps[0]!, ...grants }] } : QUICK_TASK_WORKFLOW;
    const parent = f.manager.startRun(workflow, { task: 'parent', runner: 'claude', ...settings, agentProfile: 'account-a', worktree: false });
    await until(() => sessions.length === 1);
    const caller = controller.credentials.authenticate(sessions[0]!.spec.env?.CEZ_DELEGATION_TOKEN!)!;
    const pump = vi.spyOn(f.manager as unknown as { pump(): Promise<void> }, 'pump').mockResolvedValue();
    prepare?.(parent.id);
    const request = { task: 'child', baseline: 'HEAD', requestId: randomUUID(), ...spawnInputs };
    const child = await controller.service.spawn(caller, request);
    return { home, parent, caller, request, child, pump };
  }
  async function launchAccepted(accepted: Awaited<ReturnType<typeof acceptIdentityWorker>>, mode: 'queued' | 'restart' | 'continue') {
    if (mode === 'restart') {
      f.manager.dispose(); sessions[0]!.finish();
      f.store.updateRun(accepted.parent.id, { status: 'waiting' }); f.store.flush();
      const store = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
      const manager = new RunManager(store, f.root); recoveredManagers.push(manager); recoveredStores.push(store);
      controller.attachProject({ id: 'restarted', root: f.root, store, manager });
      await manager.recover(); return { manager, store };
    }
    accepted.pump.mockRestore(); await (f.manager as unknown as { pump(): Promise<void> }).pump();
    return { manager: f.manager, store: f.store };
  }
  it.each(RUNNER_IDS.flatMap(backend => ['start', 'continue', 'recovery', 'noninteractive', 'off'].map(mode => ({ backend, mode }))))('provisions governed intent for $backend on $mode', async ({ backend, mode }) => {
    if (mode === 'off') vi.stubEnv('CEZ_DELEGATION', '0');
    const workflow = mode === 'noninteractive'
      ? { ...QUICK_TASK_WORKFLOW, steps: [{ ...QUICK_TASK_WORKFLOW.steps[0]!, id: 'preflight' }, QUICK_TASK_WORKFLOW.steps[0]!] }
      : QUICK_TASK_WORKFLOW;
    let run;
    if (mode === 'recovery') {
      run = f.store.createRun({ title: 'queued', task: 'recover', workflow: 'quick-task', runner: backend, steps: [{ id: 'task', name: 'Task', kind: 'agent' }] });
      await f.manager.recover();
    } else run = f.manager.startRun(workflow, { task: 'parent', runner: backend, worktree: false });
    await until(() => sessions.length === 1);
    const initial = sessions[0]!.spec.env?.CEZ_DELEGATION_TOKEN;
    if (mode === 'continue') {
      sessions[0]!.finish(); await until(() => !f.manager.isActive(run.id));
      expect(f.manager.continueRun(run.id, { text: 'continue' }).ok).toBe(true);
      await until(() => sessions.length === 2);
      expect(sessions[1]!.spec.env?.CEZ_DELEGATION_TOKEN).not.toBe(initial);
    }
    const spec = sessions.at(-1)!.spec;
    if (mode === 'off') {
      expect(spec.restrictNativeDelegation).toBeUndefined();
      expect(spec.env?.CEZ_DELEGATION_TOKEN).toBeUndefined();
    } else {
      expect(spec.restrictNativeDelegation).toBe(true);
      expect(spec.systemPrompt).toContain('cezar');
      expect(spec.systemPrompt).toContain('--effort');
      expect(spec.systemPrompt).toContain('--workflow');
      expect(controller.credentials.authenticate(spec.env?.CEZ_DELEGATION_TOKEN!)).toMatchObject({ runId: run.id });
    }
    // These mocked roots still finish asynchronously after cancellation. Wait before
    // afterEach removes their repository, especially recovery's worktree metadata.
    f.manager.cancel(run.id);
    for (const session of sessions) session.finish();
    await until(() => !f.manager.isActive(run.id));
  });
  it('executes a catalog workflow in the worker: a failing check loops back once, then the chain settles (#451)', async () => {
    const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
    // The check fails on its first invocation only, from inside the worker's own worktree.
    writeFileSync(join(dir, 'review.yaml'), [
      'name: review', 'steps:',
      '  - id: inspect', '    name: Inspect', '    prompt: "Review: {{task}}"',
      '  - id: verify', '    command: test -f .verified || { touch .verified; echo first-run-fails; exit 1; }',
      '    onFail: { retry: inspect, max: 2 }',
    ].join('\n'));
    const parent = f.manager.startRun(QUICK_TASK_WORKFLOW, { task: 'parent', runner: 'claude', worktree: false });
    await until(() => sessions.length === 1);
    const caller = controller.credentials.authenticate(sessions[0]!.spec.env?.CEZ_DELEGATION_TOKEN!)!;
    const child = await controller.service.spawn(caller, { task: 'child', baseline: 'HEAD', requestId: randomUUID(), workflow: 'review' });
    await until(() => sessions.length === 2);
    expect(sessions[1]!.spec.userPrompt).toContain('Review: child');
    expect(sessions[1]!.spec.cwd).not.toBe(f.root);
    sessions[1]!.finish('first attempt');
    // The check fails, so the agent step runs again with the failing output appended.
    await until(() => sessions.length === 3);
    expect(sessions[2]!.spec.userPrompt).toContain('first-run-fails');
    sessions[2]!.finish('second attempt');
    // No committed diff and no review gate in this fixture: the chain settles as done.
    await until(() => f.store.getRun(child.workerId)?.status === 'done');
    const worker = f.store.getRun(child.workerId)!;
    expect(worker.steps.map(step => ({ id: step.id, kind: step.kind, status: step.status, iterations: step.iterations }))).toEqual([
      { id: 'inspect', kind: 'agent', status: 'done', iterations: 2 }, { id: 'verify', kind: 'check', status: 'done', iterations: 2 },
    ]);
    expect(f.store.readEvents(child.workerId).filter(event => event.type === 'check-output')).toHaveLength(2);
    expect(f.store.getRun(parent.id)?.delegation).toMatchObject({ role: 'root' });
  });
  it.each(['queued', 'restart', 'continue'] as const)('refuses a catalog worker whose public workflow definition was edited after acceptance on %s (#451)', async mode => {
    const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'review.yaml'), 'name: review\nsteps:\n  - id: inspect\n    prompt: "Review: {{task}}"\n  - id: verify\n    command: "true"\n');
    const a = await acceptIdentityWorker(undefined, undefined, { workflow: 'review' });
    expect(f.store.readWorkerIdentity(a.child.workerId)).toMatchObject({ workflowHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    if (mode === 'continue') {
      await launchAccepted(a, mode); await until(() => sessions.length === 2);
      sessions[1]!.finish(); expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    }
    const worker = f.store.getRun(a.child.workerId)!;
    f.store.updateRun(worker.id, { workflowDef: { ...worker.workflowDef!, steps: [{ id: 'inspect', prompt: 'injected {{task}}' }, { id: 'verify', command: 'exit 99' }] } });
    if (mode === 'continue') expect(f.manager.continueRun(worker.id, { text: 'again' })).toMatchObject({ ok: false, error: expect.stringContaining('workflow') });
    else {
      const { store } = await launchAccepted(a, mode);
      await until(() => store.getRun(worker.id)?.status === 'failed' || sessions.length > 1);
      expect(store.getRun(worker.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('workflow') });
    }
    expect(sessions).toHaveLength(mode === 'continue' ? 2 : 1);
  });
  it('refuses a failed continuation checkpoint without advancing revision or opening another session', async () => {
    const a = await acceptIdentityWorker(); await launchAccepted(a, 'queued'); await until(() => sessions.length === 2);
    sessions[1]!.emit({ type: 'session', sessionId: 'worker-session' }); sessions[1]!.finish();
    expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    const run = f.store.getRun(a.child.workerId)!; const steps = structuredClone(run.steps);
    const failure = vi.spyOn(f.store as unknown as { writeIndex(): void }, 'writeIndex').mockImplementation(() => { throw Error('disk failure'); });
    expect(f.manager.continueRun(run.id, { text: 'again' })).toMatchObject({ ok: false });
    expect(run.delegation).not.toHaveProperty('executionRevision'); expect(run.steps).toEqual(steps);
    failure.mockRestore();
    await until(() => !f.manager.isActive(run.id));
    expect(sessions).toHaveLength(2);
  });
  it('persists result-only assistant evidence on initial execution and authorized Continue', async () => {
    const a = await acceptIdentityWorker(); await launchAccepted(a, 'queued'); await until(() => sessions.length === 2);
    sessions[1]!.emit({ type: 'session', sessionId: 'worker-session' });
    sessions[1]!.finish('Initial result-only summary');
    expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    expect(await controller.service.collect(a.caller, { workerId: a.child.workerId })).toMatchObject({ revision: 0, settled: true, summary: { state: 'available', text: 'Initial result-only summary' } });
    expect(f.manager.continueRun(a.child.workerId, { text: 'again' }).ok).toBe(true);
    expect(f.store.getRun(a.child.workerId)?.delegation).toMatchObject({ executionRevision: 1 });
    const disk = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(disk.getRun(a.child.workerId)?.delegation).toMatchObject({ executionRevision: 1 }); disk.flush();
    await until(() => sessions.length === 3);
    sessions[2]!.finish('Continuation result-only summary');
    expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    expect(await controller.service.collect(a.caller, { workerId: a.child.workerId })).toMatchObject({ revision: 1, settled: true, summary: { state: 'available', text: 'Continuation result-only summary' } });
  });
  it.each(['queued', 'restart', 'continue'] as const)('pins explicitly selected mixed-backend identity and defaults on %s', async mode => {
    const home = join(f.root, 'codex-account'); mkdirSync(home); vi.stubEnv('CODEX_HOME', home);
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-5.1-codex"');
    const a = await acceptIdentityWorker(undefined, { allowedTools: [], bashAllowlist: [] }, { backend: 'codex', context: { text: 'selected context only' } });
    expect(f.store.readWorkerIdentity(a.child.workerId)).toMatchObject({ account: { provider: 'codex', homePath: home }, model: 'gpt-5.1-codex', grants: { allowedTools: [], bashAllowlist: [] } });
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-5.1-codex-mini"');
    await launchAccepted(a, mode); await until(() => sessions.length === 2);
    expect(sessions[1]!.spec.userPrompt).toContain('selected context only');
    if (mode === 'continue') {
      sessions[1]!.finish(); expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
      expect(f.manager.continueRun(a.child.workerId, { text: 'again' }).ok).toBe(true); await until(() => sessions.length === 3);
    }
    expect(sessions.at(-1)!.spec).toMatchObject({ restrictNativeDelegation: true, model: 'gpt-5.1-codex', allowedTools: [], bashAllowlist: [] });
    expect(sessions.at(-1)!.spec.effort).toBeUndefined();
    expect(sessions.at(-1)!.spec.env?.CODEX_HOME).toBe(home);
    expect(sessions.at(-1)!.spec.env?.CEZ_DELEGATION_TOKEN).not.toBe(sessions[0]!.spec.env?.CEZ_DELEGATION_TOKEN);
  });
  it.each(['queued', 'restart', 'continue'] as const)('runs a mixed-runner chain with each agent step under its own account, model and grants on %s (#452)', async mode => {
    const codexHome = join(f.root, 'codex-account'); mkdirSync(codexHome); vi.stubEnv('CODEX_HOME', codexHome);
    writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-5.1-codex"');
    const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'mixed.yaml'), ['name: mixed', 'steps:',
      '  - id: implement', '    prompt: "Implement: {{task}}"', '    runner: codex', '    allowedTools: [Read]',
      '  - id: review', '    prompt: "Review: {{task}}"', '    runner: claude'].join('\n'));
    const a = await acceptIdentityWorker(undefined, undefined, { workflow: 'mixed' });
    const worker = f.store.getRun(a.child.workerId)!;
    // Run-level columns follow the first agent step; the identity pins both.
    expect(worker).toMatchObject({ runner: 'codex', model: 'gpt-5.1-codex', agentProfile: 'default' });
    expect(worker.effort).toBeUndefined();
    expect(f.store.readWorkerIdentity(worker.id)).toMatchObject({ account: { provider: 'codex', homePath: codexHome }, steps: [
      { stepId: 'implement', account: { provider: 'codex', profileId: 'default', homePath: codexHome }, model: 'gpt-5.1-codex', grants: { allowedTools: ['Read'] } },
      { stepId: 'review', account: { provider: 'claude', profileId: 'account-a', homePath: a.home }, model: 'haiku', effort: 'high' },
    ] });
    const { store } = await launchAccepted(a, mode === 'continue' ? 'queued' : mode);
    await until(() => sessions.length === 2);
    const implement = sessions[1]!.spec;
    expect(implement.userPrompt).toContain('Implement: child');
    expect(implement).toMatchObject({ model: 'gpt-5.1-codex', allowedTools: ['Read'] });
    expect(implement.effort).toBeUndefined();
    expect(implement.env?.CODEX_HOME).toBe(codexHome);
    expect(implement.env?.CLAUDE_CONFIG_DIR).not.toBe(a.home);
    sessions[1]!.finish('implemented');
    await until(() => sessions.length === 3);
    const review = sessions[2]!.spec;
    expect(review.userPrompt).toContain('Review: child');
    expect(review).toMatchObject({ model: 'haiku', effort: 'high' });
    expect(review.allowedTools).toEqual(sessions[0]!.spec.allowedTools);
    expect(review.env?.CLAUDE_CONFIG_DIR).toBe(a.home);
    expect(review.env?.CODEX_HOME).not.toBe(codexHome);
    expect(store.getRun(worker.id)?.steps.map(step => ({ id: step.id, backend: step.backend, profileId: step.profileId }))).toEqual([
      { id: 'implement', backend: 'codex', profileId: 'default' }, { id: 'review', backend: 'claude', profileId: 'account-a' },
    ]);
    if (mode !== 'continue') return;
    sessions[2]!.emit({ type: 'session', sessionId: 'review-session' }); sessions[2]!.finish('reviewed');
    expect(await f.manager.awaitRunTermination(worker.id, 15000)).toBe(true);
    // A Continue extends the LAST agent step, so it resumes under that step's identity, not the run-level codex one.
    expect(f.manager.continueRun(worker.id, { text: 'again', runner: 'codex' })).toMatchObject({ ok: false, error: expect.stringContaining('identity') });
    expect(f.manager.continueRun(worker.id, { text: 'again' }).ok).toBe(true);
    await until(() => sessions.length === 4);
    expect(sessions[3]!.spec).toMatchObject({ model: 'haiku', effort: 'high', resume: true, sessionId: 'review-session' });
    expect(sessions[3]!.spec.env?.CLAUDE_CONFIG_DIR).toBe(a.home);
    expect(sessions[3]!.spec.env?.CODEX_HOME).not.toBe(codexHome);
  });
  it('launches a later step under its own account even after the first step\'s account home is gone (#465 review)', async () => {
    const codexHome = join(f.root, 'codex-account'); mkdirSync(codexHome); vi.stubEnv('CODEX_HOME', codexHome);
    const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'mixed.yaml'), ['name: mixed', 'steps:',
      '  - id: implement', '    prompt: "Implement: {{task}}"', '    runner: codex',
      '  - id: review', '    prompt: "Review: {{task}}"', '    runner: claude'].join('\n'));
    const a = await acceptIdentityWorker(undefined, undefined, { workflow: 'mixed' });
    await launchAccepted(a, 'queued'); await until(() => sessions.length === 2);
    expect(sessions[1]!.spec.env?.CODEX_HOME).toBe(codexHome);
    // The codex login is removed once its step is over. The claude step's own pinned account is intact.
    rmSync(codexHome, { recursive: true, force: true });
    sessions[1]!.finish('implemented');
    await until(() => sessions.length === 3 || f.store.getRun(a.child.workerId)?.status === 'failed');
    expect(f.store.getRun(a.child.workerId)?.error).toBeUndefined();
    expect(sessions[2]!.spec.userPrompt).toContain('Review: child');
    expect(sessions[2]!.spec.env?.CLAUDE_CONFIG_DIR).toBe(a.home);
  });
  // Round 2 of #465: a completed mixed chain whose FIRST step's login is gone must still Continue
  // and recover into its LAST step's account, live and across a restart.
  async function finishedMixedChain() {
    const codexHome = join(f.root, 'codex-account'); mkdirSync(codexHome); vi.stubEnv('CODEX_HOME', codexHome);
    const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'mixed.yaml'), ['name: mixed', 'steps:',
      '  - id: implement', '    prompt: "Implement: {{task}}"', '    runner: codex',
      '  - id: review', '    prompt: "Review: {{task}}"', '    runner: claude'].join('\n'));
    const a = await acceptIdentityWorker(undefined, undefined, { workflow: 'mixed' });
    await launchAccepted(a, 'queued'); await until(() => sessions.length === 2);
    sessions[1]!.finish('implemented'); await until(() => sessions.length === 3);
    sessions[2]!.emit({ type: 'session', sessionId: 'review-session' }); sessions[2]!.finish('reviewed');
    expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    rmSync(codexHome, { recursive: true, force: true });
    return { a, codexHome };
  }
  it('continues a mixed chain into its last step\'s account after the first step\'s account home is gone (#465 review)', async () => {
    const { a } = await finishedMixedChain();
    expect(f.manager.continueRun(a.child.workerId, { text: 'again' }).ok).toBe(true);
    await until(() => sessions.length === 4 || f.store.getRun(a.child.workerId)?.status === 'failed');
    expect(f.store.getRun(a.child.workerId)?.error).toBeUndefined();
    expect(sessions[3]!.spec).toMatchObject({ resume: true, sessionId: 'review-session' });
    expect(sessions[3]!.spec.env?.CLAUDE_CONFIG_DIR).toBe(a.home);
  });
  it.each(['queued', 'restart', 'continue'] as const)('still runs a single-runner worker whose identity evidence predates per-step entries on %s (#452)', async mode => {
    const a = await acceptIdentityWorker();
    // Evidence written before #452 carries only the run-level fields.
    const path = join(f.root, '.ai/cezar/runs', `${a.child.workerId}.identity.json`);
    const { steps: _steps, ...legacy } = JSON.parse(readFileSync(path, 'utf8'));
    expect(_steps).toHaveLength(1); writeFileSync(path, JSON.stringify(legacy));
    expect(f.store.readWorkerIdentity(a.child.workerId)).not.toHaveProperty('steps');
    await launchAccepted(a, mode); await until(() => sessions.length === 2);
    if (mode === 'continue') {
      sessions[1]!.finish(); expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
      expect(f.manager.continueRun(a.child.workerId, { text: 'again' }).ok).toBe(true); await until(() => sessions.length === 3);
    }
    expect(sessions.at(-1)!.spec).toMatchObject({ model: 'haiku', effort: 'high' });
    expect(sessions.at(-1)!.spec.env?.CLAUDE_CONFIG_DIR).toBe(a.home);
  });
  it.each(['queued', 'restart', 'continue'] as const)('rejects lost accepted input recipes on %s', async mode => {
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
      expect(store.getRun(worker.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('context') });
    }
    expect(sessions).toHaveLength(mode === 'continue' ? 2 : 1);
  });
  it.each(['queued', 'restart', 'continue'].flatMap(mode => ['original-deleted', 'copy-missing', 'both-changed'].map(damage => ({ mode: mode as 'queued' | 'restart' | 'continue', damage }))))('verifies or rebuilds explicit context with $damage on $mode', async ({ mode, damage }) => {
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
      expect(store.getRun(a.child.workerId)).toMatchObject({ status: 'failed', error: expect.stringContaining('context input') });
      expect(sessions).toHaveLength(expectedSessions - 1);
    } else {
      await until(() => sessions.length === expectedSessions);
      expect(readFileSync(copy, 'utf8')).toBe('accepted document');
    }
  });
  it.each(['restart', 'continue'].flatMap(mode => ['missing', 'malformed', 'missing-step'].flatMap(damage => [[], ['Read']].map(allowedTools => ({ mode: mode as 'restart' | 'continue', damage, allowedTools })))))('pins accepted $allowedTools grants across $damage workflow on $mode', async ({ mode, damage, allowedTools }) => {
    const grants = { allowedTools, bashAllowlist: ['git status'] };
    const a = await acceptIdentityWorker(undefined, grants);
    if (mode === 'continue') {
      await launchAccepted(a, mode); await until(() => sessions.length === 2);
      sessions[1]!.finish(); expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    }
    // Simulate exactly the public on-disk salvage boundary, keeping private identity intact.
    f.store.flush(); const path = join(f.root, '.ai/cezar/runs.json');
    const records = JSON.parse(readFileSync(path, 'utf8'));
    const record = records.find((r: { id: string }) => r.id === a.child.workerId);
    if (damage === 'missing') delete record.workflowDef;
    else if (damage === 'malformed') record.workflowDef.name = 42;
    else record.workflowDef.steps = [{ id: 'different', prompt: '{{task}}' }];
    writeFileSync(path, JSON.stringify(records));
    f.manager.dispose(); sessions[0]!.finish();
    const store = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    const manager = new RunManager(store, f.root); recoveredManagers.push(manager); recoveredStores.push(store);
    // Keep root live without restarting its old session; this case concerns only the worker.
    store.updateRun(a.parent.id, { status: 'waiting' });
    controller.attachProject({ id: 'grants-reopened', root: f.root, store, manager });
    if (mode === 'continue') expect(manager.continueRun(a.child.workerId, { text: 'again' }).ok).toBe(true);
    else await manager.recover();
    await until(() => sessions.length === (mode === 'continue' ? 3 : 2));
    expect(sessions.at(-1)!.spec.allowedTools).toEqual(grants.allowedTools);
    expect(sessions.at(-1)!.spec.bashAllowlist).toEqual(grants.bashAllowlist);
  });

  it.each(['queued', 'restart', 'continue'].flatMap(mode => ['missing', 'malformed'].map(damage => ({ mode: mode as 'queued' | 'restart' | 'continue', damage }))))('refuses $damage private accepted grants on $mode', async ({ mode, damage }) => {
    const a = await acceptIdentityWorker(undefined, { allowedTools: [], bashAllowlist: [] });
    if (mode === 'continue') {
      await launchAccepted(a, mode); await until(() => sessions.length === 2);
      sessions[1]!.finish(); expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    }
    const path = join(f.root, '.ai/cezar/runs', `${a.child.workerId}.identity.json`);
    const identity = JSON.parse(readFileSync(path, 'utf8'));
    if (damage === 'missing') delete identity.grants; else identity.grants = { allowedTools: 'Read' };
    writeFileSync(path, JSON.stringify(identity));
    if (mode === 'continue') expect(f.manager.continueRun(a.child.workerId, { text: 'again' })).toMatchObject({ ok: false, error: expect.stringContaining('identity') });
    else {
      const { store } = await launchAccepted(a, mode);
      await until(() => store.getRun(a.child.workerId)?.status === 'failed' || sessions.length > 1);
      expect(store.getRun(a.child.workerId)).toMatchObject({ status: 'failed', error: expect.stringContaining('identity') });
    }
    expect(sessions).toHaveLength(mode === 'continue' ? 2 : 1);
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
    const caller = controller.credentials.authenticate(sessions[0]!.spec.env?.CEZ_DELEGATION_TOKEN!)!;
    const pump = vi.spyOn(f.manager as unknown as { pump(): Promise<void> }, 'pump').mockResolvedValue();
    const request = { task: 'child', baseline: 'HEAD', requestId: randomUUID() };
    const child = await controller.service.spawn(caller, request);
    return { home, nativeHome, parent, caller, pump, request, child };
  }
  function claudeState(spec: AgentRunSpec) {
    const env = buildChildEnv({ backend: 'claude', extraEnv: spec.env });
    return claudeStateFilePath(agentHomePaths(env).claude, env);
  }
  it.each(['queued', 'restart', 'continue'].flatMap(mode => ['native', 'override', 'named'].map(layout => ({ mode: mode as 'queued' | 'restart' | 'continue', layout: layout as 'native' | 'override' | 'named' }))))('preserves Claude $layout state-file layout on $mode', async ({ mode, layout }) => {
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
  it.each(['queued', 'restart', 'continue'].flatMap(mode => ['same-dir-override', 'other-override', 'home'].map(change => ({ mode: mode as 'queued' | 'restart' | 'continue', change }))))('refuses incompatible native Claude $change environment on $mode', async ({ mode, change }) => {
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
      expect(store.getRun(a.child.workerId)).toMatchObject({ status: 'failed', error: expect.stringContaining('layout') });
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
    expect(store.getRun(a.child.workerId)).toMatchObject({ status: 'failed', error: expect.stringContaining('layout') }); expect(sessions).toHaveLength(1);
  });
  it.each(['queued', 'restart', 'continue'] as const)('refuses missing private Claude layout evidence on %s', async mode => {
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
      expect(store.getRun(a.child.workerId)).toMatchObject({ status: 'failed', error: expect.stringContaining('identity') });
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
  it.each(['queued', 'restart', 'continue'].flatMap(mode => ['delete', 'repoint'].map(change => ({ mode: mode as 'queued' | 'restart' | 'continue', change }))))('pins account home after registry $change on $mode', async ({ mode, change }) => {
    const a = await acceptIdentityWorker();
    if (mode === 'continue') {
      await launchAccepted(a, mode); await until(() => sessions.length === 2);
      sessions[1]!.finish(); expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    }
    const other = join(f.root, 'account-b'); mkdirSync(other);
    await mergeWriteAgentAccounts(store => { store.accounts[0]!.configDir = other; });
    // Matching replay cannot rebind accepted identity, including after the row is deleted.
    expect(await controller.service.spawn(a.caller, a.request)).toEqual(a.child);
    if (change === 'delete') await mergeWriteAgentAccounts(store => { store.accounts = []; });
    if (mode === 'continue') expect(f.manager.continueRun(a.child.workerId, { text: 'again' }).ok).toBe(true);
    else await launchAccepted(a, mode);
    await until(() => sessions.length === (mode === 'continue' ? 3 : 2));
    const worker = sessions.at(-1)!;
    expect(worker.spec.env?.CLAUDE_CONFIG_DIR).toBe(a.home);
    expect(worker.spec.model).toBe('haiku'); expect(worker.spec.effort).toBe('high');
  });
  it.each(['queued', 'restart', 'continue'].flatMap(mode => [{ model: 'haiku' }, { effort: 'high' }].map(settings => ({ mode: mode as 'queued' | 'restart' | 'continue', settings }))))('explicitly refuses accepted $settings after model lock on $mode', async ({ mode, settings }) => {
    const a = await acceptIdentityWorker(settings);
    if (mode === 'continue') {
      await launchAccepted(a, mode); await until(() => sessions.length === 2);
      sessions[1]!.finish(); expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    }
    vi.stubEnv('CEZ_AGENT_MODELS_LOCKED', '1');
    if (mode === 'continue') {
      expect(f.manager.continueRun(a.child.workerId, { text: 'again' })).toMatchObject({ ok: false, error: expect.stringContaining('locked') });
    } else {
      const { store } = await launchAccepted(a, mode);
      await until(() => store.getRun(a.child.workerId)?.status === 'failed' || sessions.length > 1);
      expect(store.getRun(a.child.workerId)?.error).toContain('locked');
    }
    expect(sessions).toHaveLength(mode === 'continue' ? 2 : 1);
  });
  it.each(['queued', 'restart', 'continue'].flatMap(mode => ['missing', 'malformed'].map(damage => ({ mode: mode as 'queued' | 'restart' | 'continue', damage }))))('refuses $damage private identity on $mode', async ({ mode, damage }) => {
    const a = await acceptIdentityWorker();
    if (mode === 'continue') {
      await launchAccepted(a, mode); await until(() => sessions.length === 2);
      sessions[1]!.finish(); expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    }
    const path = join(f.root, '.ai/cezar/runs', `${a.child.workerId}.identity.json`);
    if (damage === 'missing') rmSync(path, { force: true }); else writeFileSync(path, '{', { mode: 0o600 });
    if (mode === 'continue') expect(f.manager.continueRun(a.child.workerId, { text: 'again' })).toMatchObject({ ok: false, error: expect.stringContaining('identity') });
    else {
      const { store } = await launchAccepted(a, mode);
      await until(() => store.getRun(a.child.workerId)?.status === 'failed' || sessions.length > 1);
      expect(store.getRun(a.child.workerId)?.error).toContain('identity');
    }
    expect(sessions).toHaveLength(mode === 'continue' ? 2 : 1);
    expect(f.store.getRun(a.child.workerId)?.delegation).toMatchObject({ role: 'worker', parentRunId: a.parent.id });
  });
  it('leaves an accepted native/default model and effort unspecified under model lock', async () => {
    const a = await acceptIdentityWorker({});
    vi.stubEnv('CEZ_AGENT_MODELS_LOCKED', '1');
    await launchAccepted(a, 'queued'); await until(() => sessions.length === 2);
    expect(sessions[1]!.spec.model).toBeUndefined(); expect(sessions[1]!.spec.effort).toBeUndefined();
    expect(f.store.getRun(a.child.workerId)?.modelIdentity).toBeUndefined();
    sessions[1]!.finish(); expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    expect(f.manager.continueRun(a.child.workerId, { text: 'again' }).ok).toBe(true);
    await until(() => sessions.length === 3);
    expect(sessions[2]!.spec.model).toBeUndefined(); expect(sessions[2]!.spec.effort).toBeUndefined();
  });
  it('refuses a vanished accepted account home without falling back', async () => {
    const a = await acceptIdentityWorker(); rmSync(a.home, { recursive: true });
    const { store } = await launchAccepted(a, 'queued');
    await until(() => store.getRun(a.child.workerId)?.status === 'failed' || sessions.length > 1);
    expect(store.getRun(a.child.workerId)?.error).toContain('identity is unavailable'); expect(sessions).toHaveLength(1);
  });
  it.each(['codex', 'opencode', 'pi'] as const)('pins supported homes while preserving %s profile limits', async runner => {
    const home = join(f.root, 'provider-home'); mkdirSync(home);
    const profile = runner === 'codex' ? 'work' : 'default';
    if (runner === 'codex') await mergeWriteAgentAccounts(store => { store.accounts = [{ id: profile, provider: runner, configDir: home, label: '', addedAt: '' }]; });
    const parent = f.manager.startRun(QUICK_TASK_WORKFLOW, { task: 'parent', runner, agentProfile: profile, worktree: false });
    await until(() => sessions.length === 1);
    const caller = controller.credentials.authenticate(sessions[0]!.spec.env?.CEZ_DELEGATION_TOKEN!)!;
    const pump = vi.spyOn(f.manager as unknown as { pump(): Promise<void> }, 'pump').mockResolvedValue();
    const child = await controller.service.spawn(caller, { task: 'child', baseline: 'HEAD', requestId: randomUUID() });
    await mergeWriteAgentAccounts(store => { store.accounts = []; });
    pump.mockRestore(); await (f.manager as unknown as { pump(): Promise<void> }).pump();
    await until(() => sessions.length === 2);
    expect(sessions[1]!.spec.env?.CODEX_HOME).toBe(runner === 'codex' ? home : undefined);
    expect(sessions[1]!.spec.env?.XDG_CONFIG_HOME).toBeUndefined();
    expect(sessions[1]!.spec.env?.OPENCODE_CONFIG_DIR).toBeUndefined();
    expect(f.store.getRun(child.workerId)?.runner).toBe(runner);
    expect(f.store.getRun(parent.id)?.agentProfile).toBe(profile);
  });
  it('supports only deliberately marked internal primitive workers, never missing identity evidence', async () => {
    const workspace = await planOwnedWorkspace(f.root, randomUUID(), f.sha);
    const worker = f.store.createOwnedRun({ title: 'internal', task: 'internal', runner: 'claude', workflow: 'quick-task', steps: [{ id: 'task', name: 'Task', kind: 'agent' }] }, f.parent.id, randomUUID(), { role: 'worker', permissions: [], parentRunId: f.parent.id, workspace }, '0'.repeat(64));
    expect(f.store.readWorkerIdentity(worker.id)).toEqual({ kind: 'internal' });
    f.manager.enqueueOwnedRun(worker.id); await until(() => sessions.length === 1);
    expect(sessions[0]!.spec.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    sessions[0]!.finish(); expect(await f.manager.awaitRunTermination(worker.id, 15000)).toBe(true);
    rmSync(join(f.root, '.ai/cezar/runs', `${worker.id}.identity.json`));
    expect(f.manager.continueRun(worker.id, { text: 'again' })).toMatchObject({ ok: false, error: expect.stringContaining('identity') });
    expect(sessions).toHaveLength(1);
  });
  it('fresh and Continue rotate/revoke inside execution, retain restrictions through accepted worker and restart', async () => {
    const workflow = { ...QUICK_TASK_WORKFLOW, steps: [{ ...QUICK_TASK_WORKFLOW.steps[0]!, model: 'haiku', allowedTools: ['Read', 'Bash'], bashAllowlist: ['git status'] }] };
    const run = f.manager.startRun(workflow, { task: 'parent', runner: 'claude', model: 'opus', systemPrompt: 'parent restriction', worktree: false });
    await until(() => sessions.length === 1);
    const first = sessions[0]!; const token = first.spec.env?.CEZ_DELEGATION_TOKEN!;
    expect(token).toBeTypeOf('string'); expect(first.spec.systemPrompt).not.toContain(token);
    expect(f.store.getRun(run.id)?.delegation).toMatchObject({ role: 'root' });
    const settings = f.manager.delegationExecutionSettings(run.id);
    expect(settings).toMatchObject({ model: 'haiku', systemPrompt: 'parent restriction', allowedTools: ['Read', 'Bash'], bashAllowlist: ['git status'] });
    // Hold admission after parent is live, so snapshot durability is independently observable.
    const pump = vi.spyOn(f.manager as unknown as { pump(): Promise<void> }, 'pump').mockResolvedValue();
    const child = await controller.service.spawn(controller.credentials.authenticate(token)!, { task: 'child', baseline: 'parent-head', requestId: randomUUID() });
    const worker = f.store.getRun(child.workerId)!;
    expect(worker).toMatchObject({ model: 'haiku', agentProfile: settings.agentProfile, systemPrompt: 'parent restriction', workflowDef: { steps: [{ allowedTools: ['Read', 'Bash'], bashAllowlist: ['git status'] }] } });
    f.store.updateRun(run.id, { model: 'sonnet', systemPrompt: 'changed parent' }); f.store.flush();
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(child.workerId)).toMatchObject({ model: 'haiku', systemPrompt: 'parent restriction', workflowDef: { steps: [{ allowedTools: ['Read', 'Bash'], bashAllowlist: ['git status'] }] } }); reopened.flush();
    first.finish(); await until(() => !f.manager.isActive(run.id));
    expect(controller.credentials.authenticate(token)).toBeUndefined();
    pump.mockRestore();
    expect(f.manager.continueRun(run.id, { text: 'continue' }).ok).toBe(true);
    await until(() => sessions.length >= 2);
    const second = sessions.find(s => s !== first && s.spec.cwd === f.root)!;
    expect(second.spec.env?.CEZ_DELEGATION_TOKEN).not.toBe(token);
    expect(controller.credentials.authenticate(second.spec.env?.CEZ_DELEGATION_TOKEN!)).toMatchObject({ runId: run.id });
    second.finish(); await until(() => !f.manager.isActive(run.id));
    expect(controller.credentials.authenticate(second.spec.env?.CEZ_DELEGATION_TOKEN!)).toBeUndefined();
  });
  it('keeps an empty tool grant and absent prompt pinned after acceptance and on worker Continue', async () => {
    const workflow = { ...QUICK_TASK_WORKFLOW, steps: [{ ...QUICK_TASK_WORKFLOW.steps[0]!, allowedTools: [], bashAllowlist: [] }] };
    const parent = f.manager.startRun(workflow, { task: 'parent', runner: 'claude', worktree: false });
    await until(() => sessions.length === 1);
    const token = sessions[0]!.spec.env?.CEZ_DELEGATION_TOKEN!;
    const pump = vi.spyOn(f.manager as unknown as { pump(): Promise<void> }, 'pump').mockResolvedValue();
    const child = await controller.service.spawn(controller.credentials.authenticate(token)!, { task: 'child', baseline: 'HEAD', requestId: randomUUID() });
    writeFileSync(join(f.root, '.ai/cezar/config.json'), JSON.stringify({ systemPrompt: 'later config must not enter accepted worker' }));
    pump.mockRestore();
    await (f.manager as unknown as { pump(): Promise<void> }).pump();
    await until(() => sessions.length === 2);
    const worker = sessions[1]!;
    expect(worker.spec.allowedTools).toEqual([]); expect(worker.spec.bashAllowlist).toEqual([]);
    expect(worker.spec.systemPrompt).not.toContain('later config');
    const diff = await fetch(`${controller.url}/${child.workerId}/diff`, { headers: { authorization: `Bearer ${token}` } });
    expect(diff.status).toBe(200);
    expect(workerDiffSchema.parse(await diff.json())).toMatchObject({ workerId: child.workerId, baselineSha: child.baselineSha, diff: '', truncated: false });
    worker.finish(); expect(await f.manager.awaitRunTermination(child.workerId, 15000)).toBe(true);
    expect(f.manager.continueRun(child.workerId, { text: 'continue worker' }).ok).toBe(true);
    await until(() => sessions.length === 3);
    expect(sessions[2]!.spec.allowedTools).toEqual([]); expect(sessions[2]!.spec.bashAllowlist).toEqual([]);
    expect(sessions[2]!.spec.systemPrompt).not.toContain('later config');
    expect(controller.credentials.authenticate(sessions[2]!.spec.env?.CEZ_DELEGATION_TOKEN!)).toMatchObject({ runId: child.workerId });
    expect(f.store.getRun(parent.id)?.delegation).toMatchObject({ role: 'root' });
  });
  it('revokes a finished workflow step before preparation of the next session', async () => {
    let entered = false; let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const engine = f.manager as unknown as { agentEnvForStep(...args: unknown[]): Promise<unknown> };
    const prepare = engine.agentEnvForStep.bind(f.manager); let count = 0;
    vi.spyOn(engine, 'agentEnvForStep').mockImplementation(async (...args) => { if (++count === 2) { entered = true; await gate; } return prepare(...args); });
    const run = f.manager.startRun({ ...QUICK_TASK_WORKFLOW, steps: [{ id: 'one', prompt: '{{task}}' }, { id: 'two', prompt: '{{task}}' }] }, { task: 'parent', runner: 'claude', worktree: false });
    try {
      await until(() => sessions.length === 1);
      const token = sessions[0]!.spec.env?.CEZ_DELEGATION_TOKEN!;
      sessions[0]!.finish(); await until(() => entered);
      expect(f.store.getRun(run.id)?.status).toBe('running');
      expect(controller.credentials.authenticate(token)).toBeUndefined();
    } finally { release(); }
  });
  it.each(['cancel', 'failed', 'done'] as const)('revokes %s authority before a slow backend finishes', async transition => {
    const run = f.manager.startRun(QUICK_TASK_WORKFLOW, { task: 'parent', runner: 'claude', worktree: false });
    await until(() => sessions.length === 1);
    const token = sessions[0]!.spec.env?.CEZ_DELEGATION_TOKEN!;
    vi.spyOn(sessions[0]!.session, 'interrupt').mockImplementation(() => {});
    if (transition === 'cancel') f.manager.cancel(run.id);
    else f.store.updateRun(run.id, { status: transition });
    expect(sessions[0]!.session.open).toBe(true);
    expect(controller.credentials.authenticate(token)).toBeUndefined();
  });
  it('root session wait returns immediately, then controller shutdown revokes without terminalizing persisted work', async () => {
    const run = f.manager.startRun(QUICK_TASK_WORKFLOW, { task: 'parent', runner: 'claude', worktree: false });
    await until(() => sessions.length === 1);
    const token = sessions[0]!.spec.env?.CEZ_DELEGATION_TOKEN!;
    const caller = controller.credentials.authenticate(token)!;
    const child = await controller.service.spawn(caller, { task: 'child', baseline: 'HEAD', requestId: randomUUID() });
    const response = await fetch(`${controller.url}/wait`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ workerIds: [child.workerId] }) });
    expect(response.status).toBe(200);
    const wait = workerWaitResultSchema.parse(await response.json());
    expect(Date.parse(wait.wait.deadline) - Date.now()).toBeGreaterThan(599000);
    expect(wait.wait.phase).toBe('registered'); expect(wait.instruction).toContain('End your turn');
    const status = f.store.getRun(run.id)?.status;
    const url = controller.url;
    await controller.close(); expect(controller.credentials.authenticate(token)).toBeUndefined(); expect(f.store.getRun(run.id)?.status).toBe(status);
    await expect(fetch(`${url}/wait`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  });
  it('attaches lazy project provisioning before recovery can launch a session', async () => {
    // A persisted queued ordinary task becomes a root only in the recovered session.
    const run = f.store.createRun({ title: 'queued', task: 'recover', workflow: 'quick-task', runner: 'claude', steps: [{ id: 'task', name: 'Task', kind: 'agent' }] }); f.store.flush();
    const contexts = new ProjectContexts({ listProjects: async () => [{ id: 'lazy', root: f.root, status: 'ok' }], prepareManager: project => controller.attachProject(project) });
    try {
      const context = await contexts.context('lazy');
      await until(() => sessions.length >= 1);
      const recovered = sessions.find(s => s.spec.env?.CEZ_TASK_ID === run.id)!;
      expect(recovered.spec.env?.CEZ_DELEGATION_TOKEN).toBeTypeOf('string');
      expect(controller.credentials.authenticate(recovered.spec.env?.CEZ_DELEGATION_TOKEN!)).toMatchObject({ projectId: 'lazy', runId: run.id });
      recovered.finish(); await until(() => !context.manager.isActive(run.id));
    } finally { contexts.disposeAll(); }
  });
});
