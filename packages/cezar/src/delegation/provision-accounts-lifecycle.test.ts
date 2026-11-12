import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { openTestRunStore } from '../runs/run-store-open.testkit.ts';
import * as agentAccounts from '../workspace/agent-accounts.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { createFixtureManager } from '../workflows/fixture-cleanup.testkit.ts';
import { workerDiffSchema, workerWaitResultSchema } from '@open-mercato/cezar-contract/delegation';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { join } from 'node:path';
import { planOwnedWorkspace } from './workspace.ts';
import { QUICK_TASK_WORKFLOW } from '../workflows/types.ts';
import { RUN_STATUS, STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import { ProjectContexts } from '../server/project-context.ts';
import { readPersistedText } from '../runs/run-store.testkit.ts';
import { provisionWorkflowFixture, delegationToken, until, PROVISION_ROWS } from './provision-workflows.testkit.ts';
import { createRunner } from '../core/runner-factory.ts';
import { createRunManager } from '../server/run-manager.testkit.ts';

// Git worktrees + a live RunManager contend under full-suite workers. until() is already 15s;
// the default 5s testTimeout / 10s hookTimeout cannot finish those waits. Teardown still cancels
// and finishes sessions without polling, then waits for owned work before removing the fixture.
describe('manager session delegation lifecycle', { timeout: 15_000 }, () => {
  const context = provisionWorkflowFixture();
  let f: typeof context.f, controller: typeof context.controller;
  const { sessions, recoveredManagers, recoveredStores, acceptIdentityWorker, launchAccepted, doneTurn } = context;
  beforeEach(() => { f = context.f; controller = context.controller; });

  it.each(PROVISION_ROWS.accountRegistry)('pins account home after registry $change on $mode', async ({ mode, change }) => {
    const a = await acceptIdentityWorker();
    if (mode === 'continue') {
      await launchAccepted(a, mode); await until(() => sessions.length === 2);
      sessions[1]!.finish(); expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    }
    const other = join(f.root, 'account-b'); mkdirSync(other);
    await mergeWriteAgentAccounts(store => { store.accounts[0]!.configDir = other; }, testHome());
    // Matching replay cannot rebind accepted identity, including after the row is deleted.
    expect(await controller.service.spawn(a.caller, a.request)).toEqual(a.child);
    if (change === 'delete') await mergeWriteAgentAccounts(store => { store.accounts = []; }, testHome());
    if (mode === 'continue') expect(f.manager.continueRun(a.child.workerId, { text: 'again' }).ok).toBe(true);
    else await launchAccepted(a, mode);
    await until(() => sessions.length === (mode === 'continue' ? 3 : 2));
    const worker = sessions.at(-1)!;
    expect(worker.spec.env?.CLAUDE_CONFIG_DIR).toBe(a.home);
    expect(worker.spec.model).toBe('haiku'); expect(worker.spec.effort).toBe('high');
  });
  it.each(PROVISION_ROWS.modelLock)('explicitly refuses accepted $settings after model lock on $mode', async ({ mode, settings }) => {
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
  it.each(PROVISION_ROWS.privateIdentity)('refuses $damage private identity on $mode', async ({ mode, damage }) => {
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
  it.each(PROVISION_ROWS.supportedHomes)('pins supported homes while preserving %s profile limits', async runner => {
    const home = join(f.root, 'provider-home'); mkdirSync(home);
    const profile = runner === 'codex' ? 'work' : 'default';
    if (runner === 'codex') await mergeWriteAgentAccounts(store => { store.accounts = [{ id: profile, provider: runner, configDir: home, label: '', addedAt: '' }]; }, testHome());
    const parent = f.manager.startRun(QUICK_TASK_WORKFLOW, { task: 'parent', runner, agentProfile: profile, worktree: false });
    await until(() => sessions.length === 1);
    const caller = controller.credentials.authenticate(delegationToken(sessions[0]!.spec))!;
    const admission = vi.spyOn(WorkspaceSemaphore.prototype, 'maxParallel').mockReturnValue(0);
    const child = await controller.service.spawn(caller, { task: 'child', baseline: 'HEAD', requestId: randomUUID() });
    await mergeWriteAgentAccounts(store => { store.accounts = []; }, testHome());
    expect(admission).toHaveBeenCalled(); admission.mockRestore(); await f.releaseAdmission();
    await until(() => sessions.length === 2);
    expect(sessions[1]!.spec.env?.CODEX_HOME).toBe(runner === 'codex' ? home : undefined);
    expect(sessions[1]!.spec.env?.XDG_CONFIG_HOME).toBeUndefined();
    expect(sessions[1]!.spec.env?.OPENCODE_CONFIG_DIR).toBeUndefined();
    expect(f.store.getRun(child.workerId)?.runner).toBe(runner);
    expect(f.store.getRun(parent.id)?.agentProfile).toBe(profile);
  });
  it('supports only deliberately marked internal primitive workers, never missing identity evidence', async () => {
    const workspace = await planOwnedWorkspace(f.root, randomUUID(), f.sha);
    const worker = f.store.createOwnedRun({ title: 'internal', task: 'internal', runner: 'claude', workflow: 'quick-task', steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] }, f.parent.id, randomUUID(), { role: 'worker', permissions: [], parentRunId: f.parent.id, workspace }, '0'.repeat(64));
    expect(f.store.readWorkerIdentity(worker.id)).toEqual({ kind: 'internal' });
    f.manager.enqueueOwnedRun(worker.id); await until(() => sessions.length === 1);
    expect(sessions[0]!.spec.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    sessions[0]!.finish(); expect(await f.manager.awaitRunTermination(worker.id, 15000)).toBe(true);
    rmSync(join(f.root, '.ai/cezar/runs', `${worker.id}.identity.json`));
    expect(f.manager.continueRun(worker.id, { text: 'again' })).toMatchObject({ ok: false, error: expect.stringContaining('identity') });
    expect(sessions).toHaveLength(1);
  });
  // A parent whose session closes with a live worker owes the refusal its done got, and the
  // scheduler continuation reopens it to deliver it (hearsay-tools/cezarion#1301, design
  // 2026-10-19-worker-waits-phase-3b § A blocked done at a turn end, "A closed session"): that
  // continuation is the parent's next session, where a human Continue used to be.
  const owesRefusal = (runId: string) => f.store.getRun(runId)?.agentInputs?.some(input => input.source === 'lifecycle' && !input.deliveredAt) === true;
  async function startSkillParent() {
    const dir = join(f.root, '.ai/cezar/skills'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'parent-skill.md'), 'PARENT SKILL BODY 778');
    const workflow = { ...QUICK_TASK_WORKFLOW, steps: [{ id: 'task', skill: 'parent-skill', prompt: '{{task}}' }] };
    const parent = f.manager.startRun(workflow, { task: 'parent', runner: 'claude', worktree: false, systemPrompt: 'parent extra' });
    await until(() => sessions.length === 1);
    // Provision guidance is appended; pin the selected skill without depending on that copy.
    expect(sessions[0]!.spec.systemPrompt).toContain('PARENT SKILL BODY 778');
    expect(sessions[0]!.spec.systemPrompt).toContain('parent extra');
    const caller = controller.credentials.authenticate(delegationToken(sessions[0]!.spec))!;
    const admission = vi.spyOn(WorkspaceSemaphore.prototype, 'maxParallel').mockReturnValue(0);
    return { parent, caller, admission };
  }
  it("does not copy the parent's selected skill into worker records", async () => {
    const { caller } = await startSkillParent();
    const children = [];
    for (let index = 0; index < 10; index++) {
      children.push(await controller.service.spawn(caller, { task: `child ${index}`, baseline: 'HEAD', requestId: randomUUID() }));
    }
    f.store.flush();
    expect(readPersistedText(join(f.root, '.ai/cezar'))).not.toContain('PARENT SKILL BODY 778');
    for (const child of children) expect(f.store.getRun(child.workerId)?.systemPrompt).toBe('parent extra');
  });
  it('gives first-session and post-Continue spawns the same inherited prompt', async () => {
    const { parent, caller, admission } = await startSkillParent();
    const first = await controller.service.spawn(caller, { task: 'first', baseline: 'HEAD', requestId: randomUUID() });
    sessions[0]!.finish(); await until(() => owesRefusal(parent.id));
    expect(admission).toHaveBeenCalled(); admission.mockRestore(); await f.releaseAdmission();
    await until(() => sessions.some(s => s !== sessions[0] && s.spec.env?.CEZ_TASK_ID === parent.id));
    const resumedAdmission = vi.spyOn(WorkspaceSemaphore.prototype, 'maxParallel').mockReturnValue(0);
    const continued = sessions.find(s => s !== sessions[0] && s.spec.env?.CEZ_TASK_ID === parent.id)!;
    const nextCaller = controller.credentials.authenticate(delegationToken(continued.spec))!;
    const second = await controller.service.spawn(nextCaller, { task: 'second', baseline: 'HEAD', requestId: randomUUID() });
    expect(resumedAdmission).toHaveBeenCalled();
    expect(f.store.getRun(first.workerId)?.systemPrompt).toBe(f.store.getRun(second.workerId)?.systemPrompt);
    expect(f.store.getRun(second.workerId)?.systemPrompt).toBe('parent extra');
  });
  it('continues and recovers a legacy worker with its inline skill prompt', async () => {
    const legacyPrompt = 'Selected skill: /legacy\n\nSkill instructions:\nLEGACY BODY';
    const workspace = await planOwnedWorkspace(f.root, randomUUID(), f.sha);
    const worker = f.store.createOwnedRun({ title: 'legacy', task: 'legacy', runner: 'claude', workflow: 'quick-task', systemPrompt: legacyPrompt,
      steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] }, f.parent.id, randomUUID(),
    { role: 'worker', permissions: [], parentRunId: f.parent.id, workspace }, '0'.repeat(64));
    const assertInlinePrompt = (spec: AgentRunSpec) => {
      expect(spec.systemPrompt?.slice(0, legacyPrompt.length)).toBe(legacyPrompt);
    };
    f.manager.enqueueOwnedRun(worker.id); await until(() => sessions.length === 1);
    assertInlinePrompt(sessions[0]!.spec);
    sessions[0]!.finish(); expect(await f.manager.awaitRunTermination(worker.id, 15000)).toBe(true);
    expect(f.manager.continueRun(worker.id, { text: 'continue legacy' }).ok).toBe(true);
    await until(() => sessions.length === 2); assertInlinePrompt(sessions[1]!.spec);
    sessions[1]!.finish(); expect(await f.manager.awaitRunTermination(worker.id, 15000)).toBe(true);
    // Persist a queued Continue, then restart through recover(), rather than checking reload alone.
    f.store.addStep(worker.id, { id: 'continue-2', name: 'Continue', kind: STEP_KIND.agent, synthetic: 'continuation' });
    setRunStatus(f.store, worker.id, RUN_STATUS.queued, { finishedAt: undefined, currentStepId: undefined, continuationMessage: { id: 'continue-2', text: 'recover legacy', origin: 'human', createdAt: new Date().toISOString() } });
    setRunStatus(f.store, f.parent.id, RUN_STATUS.waiting); f.store.close(); f.manager.dispose();
    const store = openTestRunStore(join(f.root, '.ai/cezar'), { keepLive: true }); recoveredStores.push(store);
    expect(store.getRun(worker.id)?.systemPrompt).toBe(legacyPrompt);
    const manager = createFixtureManager(store, f.root); recoveredManagers.push(manager);
    controller.attachProject({ home: testHome(), id: 'restarted-legacy', root: f.root, store, manager });
    await manager.recover(); await until(() => sessions.length === 3);
    expect(sessions[2]!.spec.env?.CEZ_TASK_ID).toBe(worker.id);
    assertInlinePrompt(sessions[2]!.spec);
    expect(store.getRun(worker.id)?.systemPrompt).toBe(legacyPrompt);
    sessions[2]!.finish(); expect(await manager.awaitRunTermination(worker.id, 15000)).toBe(true);
  });
  it('fresh and Continue rotate/revoke inside execution, retain restrictions through accepted worker and restart', async () => {
    const workflow = { ...QUICK_TASK_WORKFLOW, steps: [{ ...QUICK_TASK_WORKFLOW.steps[0]!, model: 'haiku', allowedTools: ['Read', 'Bash'], bashAllowlist: ['git status'] }] };
    const run = f.manager.startRun(workflow, { task: 'parent', runner: 'claude', model: 'opus', systemPrompt: 'parent restriction', worktree: false });
    await until(() => sessions.length === 1);
    const first = sessions[0]!; const token = delegationToken(first.spec);
    expect(token).toBeTypeOf('string'); expect(first.spec.systemPrompt).not.toContain(token);
    expect(f.store.getRun(run.id)?.delegation).toMatchObject({ role: 'root' });
    const settings = f.manager.delegationExecutionSettings(run.id);
    expect(settings).toMatchObject({ model: 'haiku', systemPrompt: 'parent restriction', allowedTools: ['Read', 'Bash'], bashAllowlist: ['git status'] });
    // Hold admission after parent is live, so snapshot durability is independently observable.
    const admission = vi.spyOn(WorkspaceSemaphore.prototype, 'maxParallel').mockReturnValue(0);
    const child = await controller.service.spawn(controller.credentials.authenticate(token)!, { task: 'child', baseline: 'parent-head', requestId: randomUUID() });
    const worker = f.store.getRun(child.workerId)!;
    expect(worker).toMatchObject({ model: 'haiku', agentProfile: settings.agentProfile, systemPrompt: 'parent restriction', workflowDef: { steps: [{ allowedTools: ['Read', 'Bash'], bashAllowlist: ['git status'] }] } });
    f.store.updateRun(run.id, { model: 'sonnet', systemPrompt: 'changed parent' }); f.store.flush();
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(child.workerId)).toMatchObject({ model: 'haiku', systemPrompt: 'parent restriction', workflowDef: { steps: [{ allowedTools: ['Read', 'Bash'], bashAllowlist: ['git status'] }] } }); reopened.flush();
    first.finish(); await until(() => owesRefusal(run.id));
    expect(controller.credentials.authenticate(token)).toBeUndefined();
    expect(admission).toHaveBeenCalled(); admission.mockRestore(); await f.releaseAdmission();
    await until(() => sessions.some(s => s !== first && s.spec.cwd === f.root));
    const second = sessions.find(s => s !== first && s.spec.cwd === f.root)!;
    expect(second.spec.env?.CEZ_DELEGATION_TOKEN).not.toBe(token);
    expect(controller.credentials.authenticate(delegationToken(second.spec))).toMatchObject({ runId: run.id });
    second.finish(); await until(() => controller.credentials.authenticate(delegationToken(second.spec)) === undefined);
  });
  it('keeps an empty tool grant and absent prompt pinned after acceptance and on worker Continue', async () => {
    const workflow = { ...QUICK_TASK_WORKFLOW, steps: [{ ...QUICK_TASK_WORKFLOW.steps[0]!, allowedTools: [], bashAllowlist: [] }] };
    const parent = f.manager.startRun(workflow, { task: 'parent', runner: 'claude', worktree: false });
    await until(() => sessions.length === 1);
    const token = delegationToken(sessions[0]!.spec);
    const admission = vi.spyOn(WorkspaceSemaphore.prototype, 'maxParallel').mockReturnValue(0);
    const child = await controller.service.spawn(controller.credentials.authenticate(token)!, { task: 'child', baseline: 'HEAD', requestId: randomUUID() });
    writeFileSync(join(f.root, '.ai/cezar/config.json'), JSON.stringify({ systemPrompt: 'later config must not enter accepted worker' }));
    expect(admission).toHaveBeenCalled(); admission.mockRestore();
    await f.releaseAdmission();
    await until(() => sessions.length === 2);
    const worker = sessions[1]!;
    expect(worker.spec.toolGrant).toEqual({ kind: 'inherited', tools: [], bashAllowlist: [] });
    expect(worker.spec.systemPrompt).not.toContain('later config');
    const diff = await fetch(`${controller.url}/${child.workerId}/diff`, { headers: { authorization: `Bearer ${token}` } });
    expect(diff.status).toBe(200);
    expect(workerDiffSchema.parse(await diff.json())).toMatchObject({ workerId: child.workerId, baselineSha: child.baselineSha, diff: '', truncated: false });
    worker.finish(); expect(await f.manager.awaitRunTermination(child.workerId, 15000)).toBe(true);
    expect(f.manager.continueRun(child.workerId, { text: 'continue worker' }).ok).toBe(true);
    await until(() => sessions.length === 3);
    expect(sessions[2]!.spec.toolGrant).toEqual({ kind: 'inherited', tools: [], bashAllowlist: [] });
    expect(sessions[2]!.spec.systemPrompt).not.toContain('later config');
    expect(controller.credentials.authenticate(delegationToken(sessions[2]!.spec))).toMatchObject({ runId: child.workerId });
    expect(f.store.getRun(parent.id)?.delegation).toMatchObject({ role: 'root' });
  });
  it('revokes a finished workflow step before preparation of the next session', async () => {
    let entered = false; let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const run = f.manager.startRun({ ...QUICK_TASK_WORKFLOW, steps: [{ id: 'one', prompt: '{{task}}' }, { id: 'two', prompt: '{{task}}' }] }, { task: 'parent', runner: 'claude', worktree: false });
    try {
      await until(() => sessions.length === 1);
      const token = delegationToken(sessions[0]!.spec);
      const load = agentAccounts.loadAgentAccounts;
      vi.spyOn(agentAccounts, 'loadAgentAccounts').mockImplementation(async () => { entered = true; await gate; return load(testHome()); });
      doneTurn(sessions[0]!, 'one'); await until(() => entered);
      expect(f.store.getRun(run.id)?.status).toBe('running');
      expect(controller.credentials.authenticate(token)).toBeUndefined();
    } finally { release(); }
  });
  it.each(PROVISION_ROWS.authorityRevocation)('revokes %s authority before a slow backend finishes', async transition => {
    const run = f.manager.startRun(QUICK_TASK_WORKFLOW, { task: 'parent', runner: 'claude', worktree: false });
    await until(() => sessions.length === 1);
    const token = delegationToken(sessions[0]!.spec);
    vi.spyOn(sessions[0]!.session, 'interrupt').mockImplementation(() => {});
    if (transition === 'cancel') f.manager.cancel(run.id);
    else setRunStatus(f.store, run.id, transition);
    expect(sessions[0]!.session.open).toBe(true);
    expect(controller.credentials.authenticate(token)).toBeUndefined();
    // The session stays open, which a settled run never has: back to running before teardown
    // stops it (hearsay-tools/cezarion#1804).
    if (transition !== 'cancel') setRunStatus(f.store, run.id, RUN_STATUS.running);
  });
  it('root session wait returns immediately, then controller shutdown revokes without terminalizing persisted work', async () => {
    const run = f.manager.startRun(QUICK_TASK_WORKFLOW, { task: 'parent', runner: 'claude', worktree: false });
    await until(() => sessions.length === 1);
    const token = delegationToken(sessions[0]!.spec);
    const caller = controller.credentials.authenticate(token)!;
    const child = await controller.service.spawn(caller, { task: 'child', baseline: 'HEAD', requestId: randomUUID() });
    const response = await fetch(`${controller.url}/wait`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ workerIds: [child.workerId] }) });
    expect(response.status).toBe(200);
    const wait = workerWaitResultSchema.parse(await response.json());
    expect(Date.parse(wait.wait.deadline!) - Date.now()).toBeGreaterThan(599000);
    expect(wait.wait.phase).toBe('registered'); expect(wait.instruction).toContain('End your turn');
    const status = f.store.getRun(run.id)?.status;
    const url = controller.url;
    await controller.close(); expect(controller.credentials.authenticate(token)).toBeUndefined(); expect(f.store.getRun(run.id)?.status).toBe(status);
    await expect(fetch(`${url}/wait`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  });
  it('attaches lazy project provisioning before recovery can launch a session', async () => {
    // A persisted queued ordinary task becomes a root only in the recovered session.
    const run = f.store.createRun({ title: 'queued', task: 'recover', workflow: 'quick-task', runner: 'claude', steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] });
    // A restart into a lazily built context: the old manager and store go first.
    f.manager.dispose(); f.store.close();
    const contexts = new ProjectContexts({ createRunner, createManager: createRunManager, home: testHome(), listProjects: async () => [{ id: 'lazy', root: f.root, status: 'ok' }], prepareManager: project => controller.attachProject(project) });
    try {
      const context = await contexts.context('lazy');
      await until(() => sessions.length >= 1);
      const recovered = sessions.find(s => s.spec.env?.CEZ_TASK_ID === run.id)!;
      expect(recovered.spec.env?.CEZ_DELEGATION_TOKEN).toBeTypeOf('string');
      expect(controller.credentials.authenticate(delegationToken(recovered.spec))).toMatchObject({ projectId: 'lazy', runId: run.id });
      recovered.finish(); await until(() => !context.manager.isActive(run.id));
    } finally { contexts.disposeAll(); }
  });
});
