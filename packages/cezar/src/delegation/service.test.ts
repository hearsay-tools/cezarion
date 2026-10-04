import { createFixtureManager } from '../workflows/fixture-cleanup.testkit.ts';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { workerSpawnRequestSchema } from '@open-mercato/cezar-contract';
import { DelegationPolicyError } from './policy.ts';
import { workerWorkflowHash } from './execution-identity.ts';
import { QUICK_TASK_WORKFLOW, skillTaskSteps } from '../workflows/types.ts';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import type { Caller } from './credentials.ts';

import { fixture } from './service.testkit.ts';
import { ensureOwnedWorkspace } from './workspace.ts';
import { DelegationService } from './service.ts';

describe('delegation service durable authority', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const input = () => ({ task: 'do work', baseline: 'parent-head', requestId: randomUUID() });
  it('accepts one durable owned creation, no resource before admission, replay survives moving HEAD and restart', async () => {
    const request = input();
    const [a, b] = await Promise.all([f.service.spawn(f.caller, request), f.service.spawn(f.caller, request)]);
    expect(a).toEqual(b); expect(a.baselineSha).toBe(f.sha);
    const worker = f.store.getRun(a.workerId)!;
    expect(worker).toMatchObject({ status: 'queued', runner: 'claude', model: 'opus', effort: 'high', delegation: { role: 'worker', permissions: [], parentRunId: f.parent.id } });
    if (worker.delegation?.role !== 'worker') throw Error('worker');
    expect(existsSync(worker.delegation.workspace.path)).toBe(false);
    const proof = f.store.readWorkerExecution(worker.id);
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'moved'], { cwd: f.root });
    expect(await f.service.spawn(f.caller, request)).toEqual(a);
    expect(f.store.readWorkerExecution(worker.id)).toEqual(proof);
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(f.parent.id)?.delegation).toMatchObject({ receipts: [{ workerId: a.workerId }] });
    expect(reopened.getRun(a.workerId)?.delegation).toEqual(worker.delegation); reopened.flush();
    await expect(f.service.spawn(f.caller, { ...request, task: 'different' })).rejects.toMatchObject({ code: 'invalid_input' });
  });
  it('accepts explicit same-backend context/model and hashes caller choices while retaining legacy hashes', async () => {
    const request = { ...input(), backend: 'claude' as const, model: ' sonnet ', context: { text: 'Only inspect the parser' } };
    const accepted = await f.service.spawn(f.caller, request);
    expect(f.store.getRun(accepted.workerId)).toMatchObject({ runner: 'claude', model: 'sonnet', effort: 'high' });
    expect(f.store.getRun(accepted.workerId)?.task).toContain('Only inspect the parser');
    expect(await f.service.inspect(f.caller, { workerId: accepted.workerId })).toMatchObject({ backend: 'claude', model: 'sonnet' });
    expect(await f.service.spawn(f.caller, { ...request, model: 'sonnet' })).toEqual(accepted);
    for (const changed of [{ context: { text: 'changed' } }, { backend: 'codex' as const }, { model: 'opus' }, { effort: 'low' }]) {
      await expect(f.service.spawn(f.caller, { ...request, ...changed })).rejects.toMatchObject({ code: 'invalid_input' });
    }
    const legacy = input(); await f.service.spawn(f.caller, legacy);
    expect(f.store.getRun(f.parent.id)?.delegation).toMatchObject({ receipts: expect.arrayContaining([
      expect.objectContaining({ requestId: legacy.requestId, requestHash: createHash('sha256').update(JSON.stringify({ task: legacy.task, baseline: legacy.baseline })).digest('hex') }),
    ]) });
  });
  it('switches backend without carrying parent provider model, effort, account, or widening empty grants', async () => {
    vi.mocked(f.manager.delegationExecutionSettings).mockReturnValue({ cwd: f.root, runner: 'claude', model: 'opus', effort: 'high', agentProfile: 'default', allowedTools: [], bashAllowlist: [], accountBinding: { provider: 'claude', profileId: 'default', homePath: f.root, claudeLayout: { kind: 'relocated' } } });
    vi.stubEnv('CODEX_HOME', f.root);
    const { workerId } = await f.service.spawn(f.caller, { ...input(), backend: 'codex' });
    expect(f.store.getRun(workerId)).toMatchObject({ runner: 'codex', agentProfile: 'default' });
    expect(f.store.getRun(workerId)?.model).toBeUndefined(); expect(f.store.getRun(workerId)?.effort).toBeUndefined();
    expect(f.store.readWorkerIdentity(workerId)).toMatchObject({ account: { provider: 'codex', homePath: f.root }, grants: { allowedTools: [], bashAllowlist: [] } });
  });
  it('applies explicit spawn effort, hashes the normalized pin, and refuses unknown or locked values', async () => {
    const same = { ...input(), effort: ' LOW ' };
    const accepted = await f.service.spawn(f.caller, same);
    expect(f.store.getRun(accepted.workerId)).toMatchObject({ runner: 'claude', effort: 'low' });
    expect(await f.service.spawn(f.caller, { ...same, effort: 'low' })).toEqual(accepted);
    await expect(f.service.spawn(f.caller, { ...same, effort: 'high' })).rejects.toMatchObject({ code: 'invalid_input' });
    vi.stubEnv('CODEX_HOME', f.root);
    const mixed = { ...input(), backend: 'codex' as const, effort: 'max' };
    const pinned = await f.service.spawn(f.caller, mixed);
    expect(f.store.getRun(pinned.workerId)).toMatchObject({ runner: 'codex', effort: 'max' });
    await expect(f.service.spawn(f.caller, { ...input(), effort: 'nope' })).rejects.toMatchObject({ code: 'invalid_input' });
    vi.stubEnv('CEZ_AGENT_MODELS_LOCKED', '1');
    await expect(f.service.spawn(f.caller, { ...input(), backend: 'codex', effort: 'high' })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(f.store.listRuns().some(run => run.effort === 'nope')).toBe(false);
  });
  it('rejects incompatible selections, unavailable accepted accounts, and model locks before acceptance', async () => {
    vi.stubEnv('CODEX_HOME', f.root);
    for (const selection of [{ backend: 'codex' as const, model: 'opus' }, { backend: 'opencode' as const, model: 'bare-model' }]) {
      await expect(f.service.spawn(f.caller, { ...input(), ...selection })).rejects.toMatchObject({ code: 'invalid_input' });
    }
    vi.stubEnv('CODEX_HOME', join(f.root, 'absent'));
    await expect(f.service.spawn(f.caller, { ...input(), backend: 'codex' })).rejects.toMatchObject({ code: 'invalid_input' });
    vi.stubEnv('CEZ_AGENT_MODELS_LOCKED', '1');
    await expect(f.service.spawn(f.caller, { ...input(), model: 'sonnet' })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(f.store.listRuns()).toHaveLength(1);
  });
  describe('explicit skill on spawn (#778)', () => {
    beforeEach(() => {
      const dir = join(f.root, '.ai/cezar/skills'); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'worker-skill.md'), '# Worker skill\nInspect the assigned task.');
    });
    it('spawns a worker on a named skill', async () => {
      const { workerId } = await f.service.spawn(f.caller, { ...input(), skill: 'worker-skill' });
      const worker = f.store.getRun(workerId)!;
      expect(worker.workflowDef).toMatchObject({ name: '(planned)', steps: [{
        ...skillTaskSteps('worker-skill')[0], runner: 'claude', agentProfile: 'default', model: 'opus', effort: 'high',
      }] });
      expect(worker.steps.map(step => step.id)).toEqual(['task']);
      expect(f.store.readWorkerIdentity(workerId)).toMatchObject({ workflowHash: workerWorkflowHash(worker.workflowDef!) });
    });
    it('rejects an unknown skill at spawn before creating a worker', async () => {
      const rejection = f.service.spawn(f.caller, { ...input(), skill: 'missing' });
      await expect(rejection).rejects.toBeInstanceOf(DelegationPolicyError);
      await expect(rejection).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/Unknown skill "missing"; available: .*worker-skill/) });
      expect(f.store.listRuns()).toHaveLength(1);
    });
    it('rejects skill with workflow in the spawn contract', () => {
      const result = workerSpawnRequestSchema.safeParse({ ...input(), skill: 'worker-skill', workflow: 'review' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: '--skill and --workflow cannot be used together' }),
      ]));
    });
    it('trims the skill name in the spawn contract', () => {
      expect(workerSpawnRequestSchema.parse({ ...input(), skill: ' worker-skill ' })).toHaveProperty('skill', 'worker-skill');
    });
    it.each(['', '   ', 'x'.repeat(201)])('rejects invalid skill names in the spawn contract %j', skill => {
      const result = workerSpawnRequestSchema.safeParse({ ...input(), skill });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(['skill']);
    });
    it('binds skill into the request hash', async () => {
      const request = { ...input(), skill: 'worker-skill' };
      const accepted = await f.service.spawn(f.caller, request);
      expect(await f.service.spawn(f.caller, { ...request, skill: ' worker-skill ' })).toEqual(accepted);
      for (const skill of ['changed', undefined]) {
        await expect(f.service.spawn(f.caller, { ...request, skill })).rejects.toMatchObject({ code: 'invalid_input', message: 'Request ID payload conflict' });
      }
    });
    it('refuses a tampered skill chain', async () => {
      const { workerId } = await f.service.spawn(f.caller, { ...input(), skill: 'worker-skill' });
      const workflow = f.store.getRun(workerId)!.workflowDef!;
      f.store.updateRun(workerId, { workflowDef: { ...workflow, steps: [{ ...workflow.steps[0]!, skill: 'injected' }] } });
      expect(() => f.manager.enqueueOwnedRun(workerId)).toThrow('Accepted worker workflow definition is unavailable or changed');
      // Preserve the root's human attention during recovery so it does not cancel the child.
      f.store.updateRun(f.parent.id, { status: 'waiting' });
      f.manager.dispose();
      const recovered = createFixtureManager(f.store, f.root);
      try { await recovered.recover(); } finally { recovered.dispose(); }
      expect(f.store.getRun(workerId)).toMatchObject({ status: 'failed', error: expect.stringContaining('Accepted worker workflow definition is unavailable or changed') });
    });
  });
  describe('catalog workflow on spawn (#451)', () => {
    const catalog = (name: string, yaml: string) => {
      const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${name}.yaml`), yaml);
    };
    const review = () => catalog('review', [
      'name: review', 'steps:',
      '  - id: inspect', '    name: Inspect', '    prompt: "Review: {{task}}"',
      '  - id: verify', '    command: npm test', '    onFail: { retry: inspect, max: 1 }',
    ].join('\n'));
    it('runs the resolved catalog steps, filling only unset agent fields from the spawn selection', async () => {
      review();
      const { workerId } = await f.service.spawn(f.caller, { ...input(), workflow: 'review' });
      const worker = f.store.getRun(workerId)!;
      expect(worker.workflow).toBe('review');
      expect(worker.steps.map(step => ({ id: step.id, kind: step.kind, name: step.name }))).toEqual([
        { id: 'inspect', kind: 'agent', name: 'Inspect' }, { id: 'verify', kind: 'check', name: 'verify' },
      ]);
      expect(worker.workflowDef).toMatchObject({ name: 'review', source: 'file', steps: [
        { id: 'inspect', prompt: 'Review: {{task}}', runner: 'claude', model: 'opus' },
        { id: 'verify', command: 'npm test', onFail: { retry: 'inspect', max: 1 } },
      ] });
      expect(worker.workflowDef!.steps[1]).not.toHaveProperty('runner');
      expect(worker.workflowDef!.steps[1]).not.toHaveProperty('model');
      expect(worker).toMatchObject({ runner: 'claude', model: 'opus', effort: 'high' });
    });
    it('keeps an authored step runner and model, and adopts the chain runner as the worker identity', async () => {
      vi.stubEnv('CODEX_HOME', f.root);
      catalog('codex-review', ['name: codex-review', 'steps:', '  - id: inspect', '    prompt: "{{task}}"', '    runner: codex'].join('\n'));
      const { workerId } = await f.service.spawn(f.caller, { ...input(), workflow: 'codex-review' });
      expect(f.store.getRun(workerId)).toMatchObject({ runner: 'codex', workflowDef: { steps: [{ runner: 'codex' }] } });
      expect(f.store.readWorkerIdentity(workerId)).toMatchObject({ account: { provider: 'codex' } });
    });
    it('rejects an unknown workflow name with invalid_input, creating nothing', async () => {
      await expect(f.service.spawn(f.caller, { ...input(), workflow: 'nope' })).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('nope') });
      expect(f.store.listRuns()).toHaveLength(1); expect(f.parent.delegation).toMatchObject({ receipts: [] });
    });
    describe('per-step worker identity (#452)', () => {
      it('accepts a mixed-runner chain, pinning one identity entry per agent step and the first step at run level', async () => {
        vi.stubEnv('CODEX_HOME', f.root);
        catalog('mixed', ['name: mixed', 'steps:',
          '  - id: implement', '    prompt: "{{task}}"', '    runner: codex',
          '  - id: verify', '    command: "true"',
          '  - id: review', '    prompt: "{{task}}"', '    runner: claude'].join('\n'));
        const { workerId } = await f.service.spawn(f.caller, { ...input(), workflow: 'mixed' });
        const worker = f.store.getRun(workerId)!;
        // Run-level columns keep the first agent step's values; codex never inherits the parent's claude model or effort.
        expect(worker).toMatchObject({ runner: 'codex', agentProfile: 'default', workflow: 'mixed' });
        expect(worker.model).toBeUndefined(); expect(worker.effort).toBeUndefined();
        expect(worker.workflowDef!.steps).toMatchObject([
          { id: 'implement', runner: 'codex', agentProfile: 'default' },
          { id: 'verify', command: 'true' },
          { id: 'review', runner: 'claude', model: 'opus', effort: 'high', agentProfile: 'default' },
        ]);
        expect(worker.workflowDef!.steps[1]).not.toHaveProperty('runner');
        expect(worker.workflowDef!.steps[1]).not.toHaveProperty('agentProfile');
        expect(f.store.readWorkerIdentity(workerId)).toMatchObject({ kind: 'accepted', account: { provider: 'codex', homePath: f.root }, grants: {}, steps: [
          { stepId: 'implement', account: { provider: 'codex', profileId: 'default', homePath: f.root }, grants: {} },
          { stepId: 'review', account: { provider: 'claude', profileId: 'default', homePath: f.root }, model: 'opus', effort: 'high', grants: {} },
        ] });
        expect(f.store.readWorkerIdentity(workerId)).not.toHaveProperty('model');
      });
      it('lets --backend fill only the steps that leave runner unset', async () => {
        vi.stubEnv('CODEX_HOME', f.root);
        catalog('partly', ['name: partly', 'steps:', '  - id: a', '    prompt: "{{task}}"', '    runner: claude', '  - id: b', '    prompt: "{{task}}"'].join('\n'));
        const { workerId } = await f.service.spawn(f.caller, { ...input(), workflow: 'partly', backend: 'codex' });
        expect(f.store.getRun(workerId)).toMatchObject({ runner: 'claude', model: 'opus', workflowDef: { steps: [{ id: 'a', runner: 'claude' }, { id: 'b', runner: 'codex' }] } });
        expect(f.store.readWorkerIdentity(workerId)).toMatchObject({ steps: [{ stepId: 'a', account: { provider: 'claude' } }, { stepId: 'b', account: { provider: 'codex' } }] });
      });
      it('narrows a step\'s authored tools to the parent\'s grants and never widens them', async () => {
        vi.mocked(f.manager.delegationExecutionSettings).mockReturnValue({ cwd: f.root, runner: 'claude', model: 'opus', effort: 'high', agentProfile: 'default',
          allowedTools: ['Read', 'Edit', 'Bash'], bashAllowlist: ['git status', 'git diff'], accountBinding: { provider: 'claude', profileId: 'default', homePath: f.root, claudeLayout: { kind: 'relocated' } } });
        catalog('tools', ['name: tools', 'steps:',
          '  - id: narrow', '    prompt: "{{task}}"', '    allowedTools: [WebFetch, Read, Bash]', '    bashAllowlist: ["git diff", "rm -rf"]',
          '  - id: inherit', '    prompt: "{{task}}"'].join('\n'));
        const { workerId } = await f.service.spawn(f.caller, { ...input(), workflow: 'tools' });
        const narrow = { allowedTools: ['Read', 'Bash'], bashAllowlist: ['git diff'] };
        const inherit = { allowedTools: ['Read', 'Edit', 'Bash'], bashAllowlist: ['git status', 'git diff'] };
        expect(f.store.readWorkerIdentity(workerId)).toMatchObject({ grants: narrow, steps: [{ stepId: 'narrow', grants: narrow }, { stepId: 'inherit', grants: inherit }] });
        expect(f.store.getRun(workerId)?.workflowDef?.steps).toMatchObject([{ id: 'narrow', ...narrow }, { id: 'inherit', ...inherit }]);
      });
      it('resolves a YAML agentProfile per step and refuses an account the registry does not know', async () => {
        const work = join(f.root, 'codex-work'); mkdirSync(work);
        await mergeWriteAgentAccounts(store => { store.accounts = [{ id: 'work', provider: 'codex', configDir: work, label: 'Work', addedAt: '' }]; });
        catalog('profiled', ['name: profiled', 'steps:', '  - id: a', '    prompt: "{{task}}"', '    runner: codex', '    agentProfile: work'].join('\n'));
        const { workerId } = await f.service.spawn(f.caller, { ...input(), workflow: 'profiled' });
        expect(f.store.getRun(workerId)).toMatchObject({ runner: 'codex', agentProfile: 'work', workflowDef: { steps: [{ id: 'a', runner: 'codex', agentProfile: 'work' }] } });
        expect(f.store.readWorkerIdentity(workerId)).toMatchObject({ account: { provider: 'codex', profileId: 'work', homePath: work }, steps: [{ stepId: 'a', account: { profileId: 'work', homePath: work } }] });
        catalog('unknown-account', ['name: unknown-account', 'steps:', '  - id: a', '    prompt: "{{task}}"', '    runner: codex', '    agentProfile: nope'].join('\n'));
        await expect(f.service.spawn(f.caller, { ...input(), workflow: 'unknown-account' })).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('nope') });
        expect(f.store.listRuns()).toHaveLength(2);
      });
      it('applies the model lock per step', async () => {
        // A parent with no pin of its own: only the authored step model can trip the lock.
        vi.mocked(f.manager.delegationExecutionSettings).mockReturnValue({ cwd: f.root, runner: 'claude', agentProfile: 'default', accountBinding: { provider: 'claude', profileId: 'default', homePath: f.root, claudeLayout: { kind: 'relocated' } } });
        catalog('plain', ['name: plain', 'steps:', '  - id: a', '    prompt: "{{task}}"'].join('\n'));
        catalog('pinned', ['name: pinned', 'steps:', '  - id: a', '    prompt: "{{task}}"', '  - id: b', '    prompt: "{{task}}"', '    model: sonnet'].join('\n'));
        vi.stubEnv('CEZ_AGENT_MODELS_LOCKED', '1');
        await expect(f.service.spawn(f.caller, { ...input(), workflow: 'plain' })).resolves.toMatchObject({ workerId: expect.any(String) });
        await expect(f.service.spawn(f.caller, { ...input(), workflow: 'pinned' })).rejects.toMatchObject({ code: 'invalid_input' });
        expect(f.store.listRuns()).toHaveLength(2);
      });
    });
    it('hashes the workflow name into the retry identity', async () => {
      review();
      const request = { ...input(), workflow: 'review' };
      const accepted = await f.service.spawn(f.caller, request);
      expect(await f.service.spawn(f.caller, request)).toEqual(accepted);
      await expect(f.service.spawn(f.caller, { ...input(), requestId: request.requestId })).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(f.service.spawn(f.caller, { ...request, workflow: 'quick-task' })).rejects.toMatchObject({ code: 'invalid_input' });
      const plain = input(); await f.service.spawn(f.caller, plain);
      expect(f.store.getRun(f.parent.id)?.delegation).toMatchObject({ receipts: expect.arrayContaining([
        expect.objectContaining({ requestId: plain.requestId, requestHash: createHash('sha256').update(JSON.stringify({ task: plain.task, baseline: plain.baseline })).digest('hex') }),
      ]) });
    });
    it('without a workflow keeps the built-in quick-task definition even when the catalog shadows the name', async () => {
      catalog('quick-task', ['name: quick-task', 'steps:', '  - id: shadow', '    prompt: "{{task}}"'].join('\n'));
      const { workerId } = await f.service.spawn(f.caller, input());
      expect(f.store.getRun(workerId)).toMatchObject({ workflow: 'quick-task', workflowDef: { ...QUICK_TASK_WORKFLOW, steps: [{ ...QUICK_TASK_WORKFLOW.steps[0]!, runner: 'claude', model: 'opus' }] } });
      expect(f.store.getRun(workerId)!.steps.map(step => step.id)).toEqual(['task']);
      const shadowed = await f.service.spawn(f.caller, { ...input(), workflow: 'quick-task' });
      expect(f.store.getRun(shadowed.workerId)!.steps.map(step => step.id)).toEqual(['shadow']);
    });
  });
  it('publishes concrete private identity before worker events/enqueue and never rewrites it on replay', async () => {
    const request = input(); let publishedIdentity: unknown;
    f.store.on('run', run => { if (run.delegation?.role === 'worker') publishedIdentity = f.store.readWorkerIdentity(run.id); });
    const worker = await f.service.spawn(f.caller, request);
    const account = { provider: 'claude', profileId: 'default', homePath: f.root, claudeLayout: { kind: 'relocated' } };
    expect(publishedIdentity).toEqual({ kind: 'accepted', grants: {}, account, model: 'opus', effort: 'high',
      steps: [{ stepId: 'task', account, grants: {}, model: 'opus', effort: 'high' }] });
    const path = join(f.root, '.ai/cezar/runs', `${worker.workerId}.identity.json`);
    const before = readFileSync(path, 'utf8');
    vi.mocked(f.manager.delegationExecutionSettings).mockReturnValue({ cwd: f.root, runner: 'claude', agentProfile: 'other', accountBinding: { provider: 'claude', profileId: 'other', homePath: '/different', claudeLayout: { kind: 'relocated' } } });
    expect(await f.service.spawn(f.caller, request)).toEqual(worker); expect(readFileSync(path, 'utf8')).toBe(before);
    expect(JSON.stringify(f.store.listRuns()) + JSON.stringify(f.store.readEvents(worker.workerId))).not.toContain('homePath');
  });
  it('cannot accept a worker without a concrete account binding', async () => {
    vi.mocked(f.manager.delegationExecutionSettings).mockReturnValue({ cwd: f.root, runner: 'claude', agentProfile: 'default' });
    await expect(f.service.spawn(f.caller, input())).rejects.toThrow();
    expect(f.store.listRuns()).toHaveLength(1); expect(f.parent.delegation).toMatchObject({ receipts: [] });
  });
  it('publishes neither receipt nor worker when private identity cannot be written', async () => {
    f.store.flush();
    const writer = f.store as unknown as { writeWorkerIdentity(id: string, identity: unknown): void };
    const write = writer.writeWorkerIdentity.bind(f.store);
    vi.spyOn(writer, 'writeWorkerIdentity').mockImplementation((id, identity) => {
      mkdirSync(join(f.root, '.ai/cezar/runs', `${id}.identity.json`), { recursive: true });
      write(id, identity);
    });
    await expect(f.service.spawn(f.caller, input())).rejects.toThrow();
    expect(f.store.listRuns()).toHaveLength(1); expect(f.parent.delegation).toMatchObject({ receipts: [] });
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(reopened.listRuns()).toHaveLength(1); expect(reopened.getRun(f.parent.id)?.delegation).toMatchObject({ receipts: [] }); reopened.flush();
  });
  it('authorizes before replay and rejects copied caller, wrong project, and worker credentials', async () => {
    const request = input(); const worker = await f.service.spawn(f.caller, request);
    for (const caller of [{ ...f.caller } as Caller, f.credentials.authenticate(f.credentials.issue('elsewhere', f.parent.id, 'new'))!, f.credentials.authenticate(f.credentials.issue('project', worker.workerId, 'new'))!]) {
      await expect(f.service.spawn(caller, request)).rejects.toMatchObject({ code: 'denied_scope' });
    }
  });
  it('blocks spawn/steer/wait during parent Finish, keeping inspect/stop/cleanup usable', async () => {
    const request = input(); const { workerId } = await f.service.spawn(f.caller, request);
    const parent = f.store.getRun(f.parent.id)!;
    if (parent.delegation?.role !== 'root') throw Error('parent');
    f.store.commitDelegation([{ id: parent.id, delegation: { ...parent.delegation, finishRequestedAt: new Date().toISOString() } }]);
    await expect(f.service.spawn(f.caller, request)).rejects.toMatchObject({ code: 'incompatible_state' });
    await expect(f.service.steer(f.caller, { workerId }, { text: 'hello' })).rejects.toMatchObject({ code: 'incompatible_state' });
    await expect(f.service.wait(f.caller, { workerIds: [workerId], timeoutSeconds: 600 })).rejects.toMatchObject({ code: 'incompatible_state' });
    expect(await f.service.inspect(f.caller, { workerId })).toMatchObject({ workerId });
    expect(await f.service.stop(f.caller, { workerId })).toEqual({ workerId, state: 'terminated' });
    expect(await f.service.destroy(f.caller, { workerId })).toEqual({ workerId, state: 'complete', remaining: [] });
  });
  it('serializes cleanup, preserves tombstone/history, and permits human retry with delegation off', async () => {
    const { workerId } = await f.service.spawn(f.caller, input());
    f.store.appendEvent(workerId, { type: 'note', message: 'history retained' });
    const result = await Promise.all([f.service.destroy(f.caller, { workerId }), f.service.destroy(f.caller, { workerId })]);
    expect(result).toEqual([{ workerId, state: 'complete', remaining: [] }, { workerId, state: 'complete', remaining: [] }]);
    expect(f.store.getRun(workerId)?.delegation).toMatchObject({ destroy: { phase: 'complete', remaining: [] } });
    expect(f.store.readEvents(workerId).some(e => e.message === 'history retained')).toBe(true);
    vi.stubEnv('CEZ_DELEGATION', '0');
    await expect(f.service.inspect(f.caller, { workerId })).rejects.toMatchObject({ code: 'unavailable_transport' });
    expect(await f.service.destroyForHuman('project', workerId)).toEqual({ workerId, state: 'complete', remaining: [] });
  });
  it('does not clean unknown termination; durably records exact remaining resources', async () => {
    const { workerId } = await f.service.spawn(f.caller, input());
    f.store.commitWorkerExecutionStart(workerId); // restart provenance: process result not known
    vi.spyOn(f.manager, 'awaitRunTermination').mockResolvedValue(false);
    expect(await f.service.destroy(f.caller, { workerId })).toMatchObject({ state: 'incomplete', remaining: ['process', 'worktree', 'branch'] });
    expect(f.store.getRun(workerId)?.delegation).toMatchObject({ destroy: { phase: 'incomplete', remaining: ['process', 'worktree', 'branch'] } });
  });
  it("releases a destroyed worker's preview before its checkout is removed (#781 final review)", async () => {
    const { workerId } = await f.service.spawn(f.caller, input());
    f.store.commitWorkerExecutionStart(workerId);
    const workspace = await ensureOwnedWorkspace(f.root, f.store.getRun(workerId)!);
    f.store.updateRun(workerId, { status: 'review', worktreePath: workspace.path, branch: workspace.branch });
    expect(f.store.commitWorkerExecutionComplete(workerId, f.store.readWorkerExecution(workerId)!.generation)).toBe(true);
    const released: Array<{ runId: string; checkoutExisted: boolean }> = [];
    const host = { portOwner: () => undefined, probe: async () => false, release: async (runId: string) => { released.push({ runId, checkoutExisted: existsSync(workspace.path) }); }, replaced: async () => undefined };
    vi.spyOn(f.manager, 'previewHost', 'get').mockReturnValue(host);
    expect(await f.service.destroy(f.caller, { workerId })).toMatchObject({ state: 'complete', remaining: [] });
    expect(released).toEqual([{ runId: workerId, checkoutExisted: true }]);
    expect(existsSync(workspace.path)).toBe(false);
  });

  it('retries a persisted incomplete destroy after termination becomes proven', async () => {
    Object.assign(f.service, { destroyRetryDelayMs: 50 });
    const { workerId } = await f.service.spawn(f.caller, input());
    f.store.commitWorkerExecutionStart(workerId);
    const worker = f.store.getRun(workerId)!;
    const workspace = await ensureOwnedWorkspace(f.root, worker);
    f.store.updateRun(workerId, { status: 'review', worktreePath: workspace.path, branch: workspace.branch });
    const termination = vi.spyOn(f.manager, 'awaitRunTermination').mockResolvedValue(false);
    expect(await f.service.destroy(f.caller, { workerId })).toMatchObject({ state: 'incomplete', remaining: ['process', 'worktree', 'branch'] });
    expect(f.store.getRun(workerId)?.delegation).toMatchObject({ destroy: { phase: 'incomplete' } });
    termination.mockRestore();
    // Recovery supplied the real process proof. The accepted destroy intent must finish itself.
    const generation = f.store.readWorkerExecution(workerId)?.generation;
    expect(generation).toBeDefined();
    expect(f.store.commitWorkerExecutionComplete(workerId, generation!)).toBe(true);
    await vi.waitFor(() => expect(f.store.getRun(workerId)?.delegation).toMatchObject({ destroy: { phase: 'complete', remaining: [] } }), { timeout: 3_000 });
  });
  it('resumes a persisted destroy after recovery and cancels pending retries on detach', async () => {
    const { workerId } = await f.service.spawn(f.caller, input());
    const worker = f.store.getRun(workerId)!;
    const generation = f.store.commitWorkerExecutionStart(workerId);
    const workspace = await ensureOwnedWorkspace(f.root, worker);
    f.store.updateRun(workerId, { status: 'review', worktreePath: workspace.path, branch: workspace.branch });
    expect(f.store.commitWorkerExecutionComplete(workerId, generation)).toBe(true);
    const current = f.store.getRun(workerId)!;
    if (current.delegation?.role !== 'worker') throw Error('worker');
    f.store.commitDelegation([{ id: workerId, delegation: { ...current.delegation, destroy: {
      requestedAt: new Date().toISOString(), phase: 'incomplete', remaining: ['worktree', 'branch'],
    } } }]);

    const restarted = new DelegationService();
    Object.assign(restarted, { destroyRetryDelayMs: 50 });
    const detach = restarted.registerProject({ id: 'project', root: f.root, store: f.store, manager: f.manager });
    restarted.armDestroyRetries('project');
    detach();
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(f.store.getRun(workerId)?.delegation).toMatchObject({ destroy: { phase: 'incomplete' } });
    expect(existsSync(workspace.path)).toBe(true);

    const stale = restarted.registerProject({ id: 'project', root: f.root, store: f.store, manager: f.manager });
    restarted.armDestroyRetries('project');
    const replacementManager = createFixtureManager(f.store, f.root);
    const replaced = restarted.registerProject({ id: 'project', root: f.root, store: f.store, manager: replacementManager });
    stale(); // a stale detach must not detach the replacement
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(f.store.getRun(workerId)?.delegation).toMatchObject({ destroy: { phase: 'incomplete' } });
    replaced();
    replacementManager.dispose();

    const attach = restarted.registerProject({ id: 'project', root: f.root, store: f.store, manager: f.manager });
    restarted.armDestroyRetries('project');
    await vi.waitFor(() => expect(f.store.getRun(workerId)?.delegation).toMatchObject({ destroy: { phase: 'complete', remaining: [] } }), { timeout: 3_000 });
    expect(existsSync(workspace.path)).toBe(false);
    attach();
  });
  it.each([false, true])('revokes an in-flight retry after project replacement when termination resolves %s', async terminated => {
    Object.assign(f.service, { destroyRetryDelayMs: 50 });
    const { workerId } = await f.service.spawn(f.caller, input());
    const worker = f.store.getRun(workerId)!;
    const generation = f.store.commitWorkerExecutionStart(workerId);
    const workspace = await ensureOwnedWorkspace(f.root, worker);
    f.store.updateRun(workerId, { status: 'review', worktreePath: workspace.path, branch: workspace.branch });
    expect(f.store.commitWorkerExecutionComplete(workerId, generation)).toBe(true);
    const current = f.store.getRun(workerId)!;
    if (current.delegation?.role !== 'worker') throw Error('worker');
    f.store.commitDelegation([{ id: workerId, delegation: { ...current.delegation, destroy: {
      requestedAt: new Date().toISOString(), phase: 'incomplete', remaining: ['worktree', 'branch'],
    } } }]);
    let release!: (value: boolean) => void;
    const held = new Promise<boolean>(resolve => { release = resolve; });
    const termination = vi.spyOn(f.manager, 'awaitRunTermination').mockReturnValue(held);
    f.service.armDestroyRetries('project');
    await vi.waitFor(() => expect(termination).toHaveBeenCalledOnce(), { timeout: 3_000 });
    const replacementManager = createFixtureManager(f.store, f.root);
    const detachReplacement = f.service.registerProject({ id: 'project', root: f.root, store: f.store, manager: replacementManager });
    const writes = vi.spyOn(f.store, 'commitDelegation');
    const results = vi.spyOn(f.store, 'commitWorkerResult');
    const events = vi.spyOn(f.store, 'appendEvent');
    release(terminated);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(writes).not.toHaveBeenCalled();
    expect(results).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    expect(f.store.getRun(workerId)?.delegation).toMatchObject({ destroy: { phase: 'terminating' } });
    expect(existsSync(workspace.path)).toBe(true);
    detachReplacement();
    replacementManager.dispose();
  });
  it('revokes cleanup inside Git preflight before an old project removes owned resources', async () => {
    const { workerId } = await f.service.spawn(f.caller, input());
    const worker = f.store.getRun(workerId)!;
    const generation = f.store.commitWorkerExecutionStart(workerId);
    const workspace = await ensureOwnedWorkspace(f.root, worker);
    f.store.updateRun(workerId, { status: 'review', worktreePath: workspace.path, branch: workspace.branch });
    expect(f.store.commitWorkerExecutionComplete(workerId, generation)).toBe(true);

    const bin = join(f.root, 'git-shim');
    const armed = join(bin, 'armed');
    const blocked = join(bin, 'blocked');
    const release = join(bin, 'release');
    mkdirSync(bin);
    const wrapper = join(bin, 'git');
    writeFileSync(wrapper, [
      '#!/bin/sh',
      'if [ -e "$TEST_OWNED_GIT_ARMED" ] && [ "$1" = "worktree" ] && [ "$2" = "list" ] && [ ! -e "$TEST_OWNED_GIT_BLOCKED" ]; then',
      '  : > "$TEST_OWNED_GIT_BLOCKED"',
      '  while [ ! -e "$TEST_OWNED_GIT_RELEASE" ]; do sleep 0.01; done',
      'fi',
      'exec "$TEST_OWNED_REAL_GIT" "$@"',
    ].join('\n'));
    chmodSync(wrapper, 0o755);
    vi.stubEnv('TEST_OWNED_REAL_GIT', execFileSync('which', ['git'], { encoding: 'utf8' }).trim());
    vi.stubEnv('TEST_OWNED_GIT_ARMED', armed);
    vi.stubEnv('TEST_OWNED_GIT_BLOCKED', blocked);
    vi.stubEnv('TEST_OWNED_GIT_RELEASE', release);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    const originalCommit = f.store.commitWorkerResult.bind(f.store);
    const results = vi.spyOn(f.store, 'commitWorkerResult').mockImplementation((parentId, value, diff) => {
      const committed = originalCommit(parentId, value, diff);
      writeFileSync(armed, '');
      return committed;
    });

    const destroying = f.service.destroy(f.caller, { workerId });
    void destroying.catch(() => {});
    let detachReplacement: (() => void) | undefined;
    let replacementManager: RunManager | undefined;
    try {
      await vi.waitFor(() => expect(existsSync(blocked)).toBe(true), { timeout: 5_000 });
      replacementManager = createFixtureManager(f.store, f.root);
      detachReplacement = f.service.registerProject({ id: 'project', root: f.root, store: f.store, manager: replacementManager });
      const oldResults = results.mock.calls.length;
      const writes = vi.spyOn(f.store, 'commitDelegation');
      const events = vi.spyOn(f.store, 'appendEvent');
      writeFileSync(release, '');
      await expect(destroying).rejects.toMatchObject({ code: 'denied_scope' });
      expect(writes).not.toHaveBeenCalled();
      expect(events).not.toHaveBeenCalled();
      expect(results).toHaveBeenCalledTimes(oldResults);
      expect(existsSync(workspace.path)).toBe(true);
      expect(execFileSync('git', ['branch', '--list', workspace.branch], { cwd: f.root, encoding: 'utf8' }).trim()).not.toBe('');
    } finally {
      writeFileSync(release, '');
      detachReplacement?.();
      replacementManager?.dispose();
    }
  });
  it('retains already-cleaned resources across an incomplete termination retry', async () => {
    const { workerId } = await f.service.spawn(f.caller, input());
    const worker = f.store.getRun(workerId)!;
    if (worker.delegation?.role !== 'worker') throw Error('worker');
    f.store.commitDelegation([{ id: workerId, delegation: { ...worker.delegation, destroy: { requestedAt: new Date().toISOString(), phase: 'incomplete', remaining: ['branch'] } } }]);
    vi.spyOn(f.manager, 'awaitRunTermination').mockResolvedValue(false);
    expect(await f.service.destroy(f.caller, { workerId })).toMatchObject({ state: 'incomplete', remaining: ['process', 'branch'] });
  });
  it('replays a spawn-only authority without requiring an unrelated inspect grant', async () => {
    const request = input(); const result = await f.service.spawn(f.caller, request);
    const parent = f.store.getRun(f.parent.id)!;
    if (parent.delegation?.role !== 'root') throw Error('parent');
    f.store.commitDelegation([{ id: parent.id, delegation: { ...parent.delegation, permissions: ['spawn'] } }]);
    expect(await f.service.spawn(f.caller, request)).toEqual(result);
  });
  // Exercise all 32 real durable creations; this is not a 5s filesystem throughput assertion.
  it('caps accepted creations at 32 including destroyed workers; replay does not consume a creation', { timeout: 30_000 }, async () => {
    const first = input(); const result = await f.service.spawn(f.caller, first);
    await f.service.destroy(f.caller, { workerId: result.workerId });
    for (let n = 1; n < 32; n++) await f.service.spawn(f.caller, input());
    expect(await f.service.spawn(f.caller, first)).toEqual(result);
    await expect(f.service.spawn(f.caller, input())).rejects.toMatchObject({ code: 'capacity_limit' });
    expect(f.store.listRuns()).toHaveLength(33);
  });
  it('queues attributed steering and denies the 33rd undelivered message', async () => {
    const { workerId } = await f.service.spawn(f.caller, input());
    for (let n = 0; n < 32; n++) expect(await f.service.steer(f.caller, { workerId }, { text: `/skill note ${n}` })).toEqual({ workerId, state: 'queued' });
    await expect(f.service.steer(f.caller, { workerId }, { text: 'excess' })).rejects.toMatchObject({ code: 'capacity_limit' });
    expect(f.store.getRun(workerId)?.agentInputs?.[0]).toMatchObject({ source: 'agent', parentRunId: f.parent.id, text: '/skill note 0' });
  });
  it('rejects generated credentials in agent task/steering text before persistence or delivery', async () => {
    f.store.registerSessionSecret(f.token);
    await expect(f.service.spawn(f.caller, { ...input(), task: `use ${f.token}` })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(f.store.listRuns()).toHaveLength(1);
    const { workerId } = await f.service.spawn(f.caller, input());
    await expect(f.service.steer(f.caller, { workerId }, { text: `use ${f.token}` })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(JSON.stringify(f.store.listRuns()) + JSON.stringify(f.store.readEvents(workerId))).not.toContain(f.token);
    expect(f.store.getRun(workerId)?.agentInputs ?? []).toEqual([]);
  });
  it('does not reveal absent or unrelated workers for any targeted operation', async () => {
    const unrelated = f.store.createRun({ title: 'other', task: 'other', workflow: 'quick-task', steps: [] });
    for (const workerId of [randomUUID(), unrelated.id]) {
      for (const op of ['inspect', 'stop', 'destroy', 'diff'] as const) await expect(f.service[op](f.caller, { workerId })).rejects.toMatchObject({ code: 'denied_scope', message: 'Worker scope denied' });
      await expect(f.service.steer(f.caller, { workerId }, { text: 'hello' })).rejects.toMatchObject({ code: 'denied_scope' });
      await expect(f.service.wait(f.caller, { workerIds: [workerId], timeoutSeconds: 600 })).rejects.toMatchObject({ code: 'denied_scope' });
    }
  });
  async function cancellableWait() {
    const { workerId } = await f.service.spawn(f.caller, input());
    const waitId = randomUUID(); const parent = f.store.getRun(f.parent.id)!;
    if (parent.delegation?.role !== 'root') throw Error('fixture');
    f.store.commitDelegation([{ id: parent.id, delegation: { ...parent.delegation, wait: {
      id: waitId, workerIds: [workerId], phase: 'registered', deadline: new Date(Date.now() + 600_000).toISOString(), outcomes: [],
    } } }]);
    return { workerId, waitId };
  }
  it('cancels a queued parent wait without stopping its worker or authorizing new work', async () => {
    const { workerId, waitId } = await cancellableWait(); f.store.updateRun(f.parent.id, { status: 'queued' });
    expect(await f.service.cancelWait(f.caller, { waitId })).toMatchObject({ wait: { id: waitId, phase: 'wake-pending', reason: 'cancelled' } });
    expect(f.store.getRun(workerId)?.status).toBe('queued');
    await expect(f.service.wait(f.caller, { workerIds: [workerId], timeoutSeconds: 600 })).rejects.toMatchObject({ code: 'incompatible_state' });
    await expect(f.service.spawn(f.caller, input())).rejects.toMatchObject({ code: 'incompatible_state' });
  });
  it.each(['done', 'review', 'failed', 'cancelled'] as const)('reads the retained cancel receipt after the parent becomes %s', async status => {
    const { waitId } = await cancellableWait();
    const settled = await f.service.cancelWait(f.caller, { waitId });
    f.store.commitWorkerWaitWithdrawal(f.parent.id, waitId); f.store.updateRun(f.parent.id, { status });
    const before = structuredClone(f.store.getRun(f.parent.id));
    expect(await f.service.cancelWait(f.caller, { waitId })).toEqual(settled);
    expect(f.store.getRun(f.parent.id)).toEqual(before);
  });
  it('collect settles a worker whose crashed generation left no live process (#469)', { timeout: 15_000 }, async () => {
    const { workerId } = await f.service.spawn(f.caller, input());
    const generation = f.store.commitWorkerExecutionStart(workerId);
    f.store.updateRun(workerId, { status: 'failed', finishedAt: new Date().toISOString() });
    const record = join(f.root, '.ai/cezar/runs', `${workerId}.processes.json`);
    const dead = spawn(process.execPath, ['-e', '']); await new Promise(resolve => dead.once('exit', resolve));
    writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, 'utf8')), controller: { pid: dead.pid, startToken: '1' } }));
    f.store.flush();
    // The restarted cezar: a fresh manager owns no execution or queue entry for the worker.
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true }); const manager = createFixtureManager(reopened, f.root);
    f.service.registerProject({ id: 'project', root: f.root, store: reopened, manager });
    try {
      // Under full-suite load the host-wide process scan can transiently return alive/unknown.
      // collect caches that conservative result for 2 s; poll it (not the finalizer) so the
      // assertion waits for proof of termination and still catches a missing collect hook (#703).
      await expect.poll(() => f.service.collect(f.caller, { workerId }), { timeout: 10_000, interval: 250 }).toMatchObject({ settled: true });
      expect(reopened.readWorkerExecution(workerId)).toEqual({ generation, phase: 'complete' });
    } finally { manager.dispose(); reopened.flush(); }
  });
  it('returns only the retained old cancellation while a queued parent has a newer wait', async () => {
    const { workerId, waitId } = await cancellableWait(); const old = await f.service.cancelWait(f.caller, { waitId });
    f.store.commitWorkerWaitWithdrawal(f.parent.id, waitId);
    const parent = f.store.getRun(f.parent.id)!; if (parent.delegation?.role !== 'root') throw Error('fixture');
    const next = { id: randomUUID(), workerIds: [workerId], phase: 'registered' as const, deadline: new Date(Date.now() + 600_000).toISOString(), outcomes: [] };
    f.store.commitDelegation([{ id: parent.id, delegation: { ...parent.delegation, wait: next } }]);
    f.store.updateRun(parent.id, { status: 'queued' });
    expect(await f.service.cancelWait(f.caller, { waitId })).toEqual(old);
    await expect(f.service.cancelWait(f.caller, { waitId: randomUUID() })).rejects.toMatchObject({ code: 'incompatible_state' });
    expect(f.store.getRun(parent.id)?.delegation).toMatchObject({ wait: next });
  });

});
