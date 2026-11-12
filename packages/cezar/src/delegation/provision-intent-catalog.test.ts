import { productName } from '../home/display.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { openTestRunStore, runPersistence } from '../runs/run-store-open.testkit.ts';
import { createFixtureManager } from '../workflows/fixture-cleanup.testkit.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { QUICK_TASK_WORKFLOW } from '../workflows/types.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { provisionWorkflowFixture, delegationToken, until, PROVISION_ROWS, PROVISION_TEST_FILES, provisionMatrixCounts } from './provision-workflows.testkit.ts';

// Git worktrees + a live RunManager contend under full-suite workers. until() is already 15s;
// the default 5s testTimeout / 10s hookTimeout cannot finish those waits. Teardown still cancels
// and finishes sessions without polling, then waits for owned work before removing the fixture.
describe('manager session delegation lifecycle', { timeout: 15_000 }, () => {
  const context = provisionWorkflowFixture();
  let f: typeof context.f, controller: typeof context.controller;
  const { sessions, recoveredManagers, recoveredStores, acceptIdentityWorker, launchAccepted, doneTurn } = context;
  beforeEach(() => { f = context.f; controller = context.controller; });

  it.each(PROVISION_ROWS.governedIntent)('provisions governed intent for $backend on $mode', async ({ backend, mode }) => {
    const workflow = mode === 'noninteractive'
      ? { ...QUICK_TASK_WORKFLOW, steps: [{ ...QUICK_TASK_WORKFLOW.steps[0]!, id: 'preflight' }, QUICK_TASK_WORKFLOW.steps[0]!] }
      : QUICK_TASK_WORKFLOW;
    let run;
    if (mode === 'recovery') {
      run = f.store.createRun({ title: 'queued', task: 'recover', workflow: 'quick-task', runner: backend, steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] });
      await f.manager.recover();
    } else run = f.manager.startRun(workflow, { task: 'parent', runner: backend, worktree: false, ...(mode === 'off' ? { allowWorkers: false, allowMessaging: false } : {}) });
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
      // hearsay-tools/cezarion#2784: both switches off issue no credential; the governed-session cross-session controls stay.
      expect(spec.restrictCrossSessionMessaging).toBe(true);
      expect(spec.env?.CEZ_DELEGATION_TOKEN).toBeUndefined();
      expect(spec.systemPrompt).toContain(`${productName('Cezar')} workers and task messaging are off for this task`);
    } else {
      expect(spec.restrictCrossSessionMessaging).toBe(true);
      expect(spec.systemPrompt).toContain('cezar');
      expect(spec.systemPrompt).toContain('--effort');
      expect(spec.systemPrompt).toContain('--workflow');
      expect(controller.credentials.authenticate(delegationToken(spec))).toMatchObject({ runId: run.id });
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
    const caller = controller.credentials.authenticate(delegationToken(sessions[0]!.spec))!;
    const child = await controller.service.spawn(caller, { task: 'child', baseline: 'HEAD', requestId: randomUUID(), workflow: 'review' });
    await until(() => sessions.length === 2);
    expect(sessions[1]!.spec.userPrompt).toContain('Review: child');
    expect(sessions[1]!.spec.cwd).not.toBe(f.root);
    doneTurn(sessions[1]!, 'first attempt');
    // The check fails, so the agent step runs again with the failing output appended.
    await until(() => sessions.length === 3);
    expect(sessions[2]!.spec.userPrompt).toContain('first-run-fails');
    doneTurn(sessions[2]!, 'second attempt');
    // No committed diff and no review gate in this fixture: the chain settles as done.
    await until(() => f.store.getRun(child.workerId)?.status === 'done');
    const worker = f.store.getRun(child.workerId)!;
    expect(worker.steps.map(step => ({ id: step.id, kind: step.kind, status: step.status, iterations: step.iterations }))).toEqual([
      { id: 'inspect', kind: STEP_KIND.agent, status: STEP_STATUS.done, iterations: 2 }, { id: 'verify', kind: STEP_KIND.check, status: STEP_STATUS.done, iterations: 2 },
    ]);
    expect(f.store.readEvents(child.workerId).filter(event => event.type === 'check-output')).toHaveLength(2);
    expect(f.store.getRun(parent.id)?.delegation).toMatchObject({ role: 'root' });
  });
  // hearsay-tools/cezarion#1620: an earlier step that ends without done settles the worker as a
  // single-step task's close does, keeps the step open, and a parent resume re-enters it.
  it('settles a worker whose earlier step ends without done, and a parent resume re-enters that step', async () => {
    const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'review.yaml'), [
      'name: review', 'steps:',
      '  - id: inspect', '    name: Inspect', '    prompt: "Review: {{task}}"',
      '  - id: verify', '    command: "true"',
    ].join('\n'));
    f.manager.startRun(QUICK_TASK_WORKFLOW, { task: 'parent', runner: 'claude', worktree: false });
    await until(() => sessions.length === 1);
    const caller = controller.credentials.authenticate(delegationToken(sessions[0]!.spec))!;
    const child = await controller.service.spawn(caller, { task: 'child', baseline: 'HEAD', requestId: randomUUID(), workflow: 'review' });
    await until(() => sessions.length === 2);
    sessions[1]!.finish('stopped early');
    await until(() => f.store.getRun(child.workerId)?.status === 'done');
    const steps = () => f.store.getRun(child.workerId)!.steps.filter(step => step.id === 'inspect' || step.id === 'verify').map(step => [step.id, step.status]);
    expect(steps()).toEqual([['inspect', 'waiting'], ['verify', 'pending']]);
    expect(f.store.readEvents(child.workerId).filter(event => event.type === 'check-output')).toEqual([]);
    await controller.service.send(caller, { id: randomUUID(), recipientRunId: child.workerId, kind: 'request', text: 'Finish the review', resume: true, timeoutSeconds: 600 });
    await until(() => sessions.length === 3);
    doneTurn(sessions[2]!, 'reviewed');
    await until(() => f.store.getRun(child.workerId)?.status === 'done' && steps()[1]?.[1] === 'done');
    expect(steps()).toEqual([['inspect', 'done'], ['verify', 'done']]);
    expect(f.store.readEvents(child.workerId).filter(event => event.type === 'check-output')).toHaveLength(1);
  });
  it.each(PROVISION_ROWS.catalogMutation)('refuses a catalog worker whose public workflow definition was edited after acceptance on %s (#451)', async mode => {
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
      expect(store.getRun(worker.id)).toMatchObject({ status: RUN_STATUS.failed, error: expect.stringContaining('workflow') });
    }
    expect(sessions).toHaveLength(mode === 'continue' ? 2 : 1);
  });
  it('refuses a failed continuation checkpoint without advancing revision or opening another session', async () => {
    const a = await acceptIdentityWorker(); await launchAccepted(a, 'queued'); await until(() => sessions.length === 2);
    sessions[1]!.emit({ type: 'session', sessionId: 'worker-session' }); sessions[1]!.finish();
    expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    const run = f.store.getRun(a.child.workerId)!; const steps = structuredClone(run.steps);
    const failure = vi.spyOn(runPersistence(f.store), 'persist').mockImplementation(() => { throw Error('disk failure'); });
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
    const disk = openTestRunStore(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(disk.getRun(a.child.workerId)?.delegation).toMatchObject({ executionRevision: 1 }); disk.flush();
    await until(() => sessions.length === 3);
    sessions[2]!.finish('Continuation result-only summary');
    expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    expect(await controller.service.collect(a.caller, { workerId: a.child.workerId })).toMatchObject({ revision: 1, settled: true, summary: { state: 'available', text: 'Continuation result-only summary' } });
  });
  it.each(PROVISION_ROWS.mixedBackend)('pins explicitly selected mixed-backend identity and defaults on %s', async mode => {
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
    expect(sessions.at(-1)!.spec).toMatchObject({ restrictCrossSessionMessaging: true, model: 'gpt-5.1-codex', toolGrant: { kind: 'inherited', tools: [], bashAllowlist: [] } });
    expect(sessions.at(-1)!.spec.effort).toBeUndefined();
    expect(sessions.at(-1)!.spec.env?.CODEX_HOME).toBe(home);
    expect(sessions.at(-1)!.spec.env?.CEZ_DELEGATION_TOKEN).not.toBe(sessions[0]!.spec.env?.CEZ_DELEGATION_TOKEN);
  });
  it.each(PROVISION_ROWS.mixedChain)('runs a mixed-runner chain with each agent step under its own account, model and grants on %s (#452)', async mode => {
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
    expect(implement).toMatchObject({ model: 'gpt-5.1-codex', toolGrant: { kind: 'inherited', tools: ['Read'] } });
    expect(implement.effort).toBeUndefined();
    expect(implement.env?.CODEX_HOME).toBe(codexHome);
    expect(implement.env?.CLAUDE_CONFIG_DIR).not.toBe(a.home);
    doneTurn(sessions[1]!, 'implemented');
    await until(() => sessions.length === 3);
    const review = sessions[2]!.spec;
    expect(review.userPrompt).toContain('Review: child');
    expect(review).toMatchObject({ model: 'haiku', effort: 'high' });
    // The identity pins the parent's lists, so the worker step resolves them as inherited.
    expect(review.toolGrant).toEqual({ ...sessions[0]!.spec.toolGrant, kind: 'inherited' });
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
  // hearsay-tools/cezarion#2991: Codex mints its own session id, so the launch UUID on a step whose
  // process ended before Codex reported a session cannot be resumed. The Continue opens a fresh
  // Codex session and still runs as that step, under its pinned identity.
  it('continues a mixed chain whose codex step ended before its session event as that step, in a fresh session', async () => {
    const codexHome = join(f.root, 'codex-account'); mkdirSync(codexHome); vi.stubEnv('CODEX_HOME', codexHome);
    writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-5.1-codex"');
    const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'mixed.yaml'), ['name: mixed', 'steps:',
      '  - id: implement', '    prompt: "Implement: {{task}}"', '    runner: codex', '    allowedTools: [Read]',
      '  - id: review', '    prompt: "Review: {{task}}"', '    runner: claude'].join('\n'));
    const a = await acceptIdentityWorker(undefined, undefined, { workflow: 'mixed' });
    await launchAccepted(a, 'queued'); await until(() => sessions.length === 2);
    const launchId = f.store.getRun(a.child.workerId)!.steps.find(step => step.id === 'implement')!.sessionId;
    expect(launchId).toBeDefined();
    sessions[1]!.finish();
    expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    expect(f.manager.continueRun(a.child.workerId, { text: 'again' })).toEqual({ ok: true });
    await until(() => sessions.length === 3 || f.store.getRun(a.child.workerId)?.status === 'failed');
    expect(f.store.getRun(a.child.workerId)?.error).toBeUndefined();
    const continued = sessions[2]!.spec;
    expect(continued.resume).toBeFalsy();
    expect(continued.sessionId).not.toBe(launchId);
    expect(continued).toMatchObject({ model: 'gpt-5.1-codex', toolGrant: { kind: 'inherited', tools: ['Read'] } });
    expect(continued.env?.CODEX_HOME).toBe(codexHome);
  }, 60_000);
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
    doneTurn(sessions[1]!, 'implemented');
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
    doneTurn(sessions[1]!, 'implemented'); await until(() => sessions.length === 3);
    sessions[2]!.emit({ type: 'session', sessionId: 'review-session' }); sessions[2]!.finish('reviewed');
    expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    rmSync(codexHome, { recursive: true, force: true });
    return { a, codexHome };
  }
  // finishedMixedChain already awaits two 15s until()s plus a 15s termination; the cell then
  // waits again. Isolated recovery is ~1s; CI on #959 hit 16338ms against the 15s describe
  // (#960). Cover the sequential waits rather than the observed 16s.
  it('continues a mixed chain into its last step\'s account after the first step\'s account home is gone (#465 review)', async () => {
    const { a } = await finishedMixedChain();
    expect(f.manager.continueRun(a.child.workerId, { text: 'again' }).ok).toBe(true);
    await until(() => sessions.length === 4 || f.store.getRun(a.child.workerId)?.status === 'failed');
    expect(f.store.getRun(a.child.workerId)?.error).toBeUndefined();
    expect(sessions[3]!.spec).toMatchObject({ resume: true, sessionId: 'review-session' });
    expect(sessions[3]!.spec.env?.CLAUDE_CONFIG_DIR).toBe(a.home);
  }, 60_000);
  it('recovers a queued continuation of a mixed chain onto its last step\'s runner and session (#465 review)', async () => {
    const { a } = await finishedMixedChain();
    // The durable shape a crash leaves behind after a continuation was accepted but not yet
    // launched: a pending synthetic `continue-1` step and its message, on a `queued` record.
    const worker = f.store.getRun(a.child.workerId)!;
    f.store.addStep(worker.id, { id: 'continue-1', name: 'Continue', kind: STEP_KIND.agent, synthetic: 'continuation' });
    setRunStatus(f.store, worker.id, RUN_STATUS.queued, { finishedAt: undefined, continuationMessage: { id: 'continue-1', text: 'again', origin: 'human', createdAt: new Date().toISOString() } });
    f.manager.dispose(); sessions[0]!.finish();
    setRunStatus(f.store, a.parent.id, RUN_STATUS.waiting); f.store.close();
    const store = openTestRunStore(join(f.root, '.ai/cezar'), { keepLive: true });
    const manager = createFixtureManager(store, f.root); recoveredManagers.push(manager); recoveredStores.push(store);
    controller.attachProject({ home: testHome(), id: 'restarted', root: f.root, store, manager });
    await manager.recover();
    await until(() => sessions.length === 4 || store.getRun(worker.id)?.status === 'failed');
    expect(store.getRun(worker.id)?.error).toBeUndefined();
    // Reconstructed from the review step's pinned identity, not the run-level codex one: the
    // claude session is resumed, under the claude account.
    expect(sessions[3]!.spec).toMatchObject({ resume: true, sessionId: 'review-session' });
    expect(sessions[3]!.spec.env?.CLAUDE_CONFIG_DIR).toBe(a.home);
    expect(sessions[3]!.spec.env?.CODEX_HOME).toBeUndefined();
  }, 60_000);
  it.each(PROVISION_ROWS.legacyIdentity)('still runs a single-runner worker whose identity evidence predates per-step entries on %s (#452)', async mode => {
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
  it('registers every provision matrix exactly once', () => {
    const sources = PROVISION_TEST_FILES.map(file => readFileSync(new URL(file, import.meta.url), 'utf8'));
    expect(provisionMatrixCounts(sources)).toEqual(Object.fromEntries(Object.keys(PROVISION_ROWS).map(name => [name, 1])));
  });

  for (const argument of [
    '[...PROVISION_ROWS.governedIntent]',
    'rows',
    'PROVISION_ROWS["governedIntent"]',
    '',
    '...PROVISION_ROWS.governedIntent',
    'PROVISION_ROWS.unknown',
    'PROVISION_ROWS.governedIntent, extra',
  ]) it(`rejects unresolved provision registration argument ${argument}`, () => {
    const call = `it.each(${argument})`;
    expect(() => provisionMatrixCounts([`${call};`], ['third-provision.test.ts'])).toThrow(`third-provision.test.ts: unsupported it.each registration: ${call}`);
  });
  it('checks nested provision registrations and ignores non-code text', () => {
    const call = 'it.each(PROVISION_ROWS.governedIntent)';
    expect(() => provisionMatrixCounts([`function later() { ${call}; }`])).toThrow();
    expect(() => provisionMatrixCounts(['function later() { it.each(rows); }'], ['nested.test.ts'])).toThrow('nested.test.ts: unsupported');
    expect(provisionMatrixCounts([`// ${call}\n/* ${call} */\nconst text = "${call}"; const template = \`${call}\`;`]).governedIntent).toBe(0);
    const declaration = `${call}('row', () => {});`;
    expect(provisionMatrixCounts([`${declaration} ${declaration}`]).governedIntent).toBe(2);
    expect(provisionMatrixCounts([`describe('suite', () => { ${declaration} });`]).governedIntent).toBe(1);
  });

  for (const source of [
    "it.each(PROVISION_ROWS.governedIntent);",
    "it.each(PROVISION_ROWS.governedIntent)('row');",
    "it.each(PROVISION_ROWS.governedIntent)('row', callback);",
    "function later() { it.each(PROVISION_ROWS.governedIntent)('row', () => {}); }",
    "if (false) { it.each(PROVISION_ROWS.governedIntent)('row', () => {}); }",
    "it('later', () => { it.each(PROVISION_ROWS.governedIntent)('row', () => {}); });",
  ]) it(`rejects provision calls that do not declare tests ${source}`, () => {
    expect(() => provisionMatrixCounts([source], ['unexecuted.test.ts'])).toThrow('unexecuted.test.ts: unsupported');
  });

  for (const source of [
    'it.each?.(PROVISION_ROWS.governedIntent)',
    'const r = it.each',
    'it.each.call(null, PROVISION_ROWS.governedIntent)',
    'consume(it.each)',
    'it.each.apply(null, [PROVISION_ROWS.governedIntent])',
    'it.each.bind(null)',
    'it["each"](PROVISION_ROWS.governedIntent)',
  ]) it(`rejects unaccounted provision registration reference ${source}`, () => {
    expect(() => provisionMatrixCounts([`${source};`], ['reference.test.ts'])).toThrow('reference.test.ts: unsupported');
  });

  for (const source of [
    'it?.["each"](PROVISION_ROWS.governedIntent)',
    'it["each"](PROVISION_ROWS.governedIntent)',
    'it[`each`](PROVISION_ROWS.governedIntent)',
    'const key = "each"',
    'const key = `each`',
  ]) it(`rejects exact provision registration-name literals ${source}`, () => {
    expect(() => provisionMatrixCounts([`${source};`], ['literal.test.ts'])).toThrow('literal.test.ts: unsupported');
  });
  it('ignores comments and longer literals containing the provision registration name', () => {
    expect(provisionMatrixCounts(['// each\n/* each */\nconst text = "prefix each suffix"; const template = `prefix each suffix`;']).governedIntent).toBe(0);
  });

});
