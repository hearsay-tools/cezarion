import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS, type AgentRunSpec, type RunnerId } from '../core/agent-runner.ts';
import { CREATE_AUTOMATION_SKILL_NAME } from '../automations/prompts.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Every spec a (mocked) runner's `startSession` receives, with the backend it was built for. */
const captured = vi.hoisted(() => ({ specs: [] as Array<{ backend: string; spec: AgentRunSpec }> }));

// What is under test is what RunManager puts INTO the spec before the runner seam, at both
// session construction sites (`execute` and `runContinuation`). The stub reports whichever
// backend it was asked for, so every runner id walks the same path.
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: (backend: string) => ({
    backend,
    systemPromptOnResume: 'resent' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec) => {
      captured.specs.push({ backend, spec });
      return {
        result: Promise.resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 }),
        sendMessage: () => false,
        discardQueuedMessages: () => {}, holdsHumanInput: () => false,
        end: () => {},
        interrupt: () => {},
        open: false,
      };
    },
    interrupt: async () => {},
  }),
}));

const ADDRESS = { origin: 'http://127.0.0.1:5555', projectId: 'proj-1' };
const PROMPT_HEADING = '## Automations';

const TASK_DEF: WorkflowDef = { name: 'quick-task', source: 'built-in', steps: [{ id: 'task', prompt: '{{task}}' }] };

describe('automations prompt part and cockpit address (#774)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  let savedFlag: string | undefined;

  beforeEach(async () => {
    captured.specs.length = 0;
    savedFlag = process.env.CEZ_AUTOMATIONS;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-automations-prompt-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
  });

  afterEach(async () => {
    if (savedFlag === undefined) delete process.env.CEZ_AUTOMATIONS; else process.env.CEZ_AUTOMATIONS = savedFlag;
    await drainFixtureManagers(repoRoot);
    manager?.dispose();
    manager = undefined;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  async function specAt(index: number): Promise<{ backend: string; spec: AgentRunSpec }> {
    await expect.poll(() => captured.specs.length, { timeout: 15_000 }).toBeGreaterThan(index);
    return captured.specs[index]!;
  }

  async function settled(runId: string): Promise<void> {
    await expect
      .poll(() => store.getRun(runId)?.status, { timeout: 15_000 })
      .toSatisfy((status) => ['done', 'review', 'failed', 'cancelled'].includes(String(status)));
  }

  /** A fresh run, then a Continue of it: the two construction sites, in that order. */
  async function startAndContinue(runner: RunnerId): Promise<[AgentRunSpec, AgentRunSpec]> {
    const record = manager!.startRun(TASK_DEF, { task: 'do it', worktree: false, runner });
    const opening = await specAt(0);
    expect(opening.backend).toBe(runner);
    await settled(record.id);
    store.updateStep(record.id, 'task', { sessionId: 'sess-1', backend: runner });
    expect(manager!.continueRun(record.id, { text: 'keep going' })).toEqual({ ok: true });
    const continued = await specAt(1);
    await settled(record.id);
    return [opening.spec, continued.spec];
  }

  it('a manager no server has addressed (headless `cez run`) injects nothing and composes nothing', async () => {
    process.env.CEZ_AUTOMATIONS = '1';
    expect(manager!.cockpitAddress()).toBeUndefined();
    const [opening, continued] = await startAndContinue('claude');
    for (const spec of [opening, continued]) {
      expect(spec.env?.CEZ_COCKPIT_URL).toBeUndefined();
      expect(spec.env?.CEZ_PROJECT_ID).toBeUndefined();
      expect(spec.systemPrompt).not.toContain(PROMPT_HEADING);
    }
    expect(manager!.builtinSkills()).toEqual([]);
  });

  it('an addressed manager with automations off injects the address but composes nothing', async () => {
    delete process.env.CEZ_AUTOMATIONS;
    manager!.setCockpitAddress(ADDRESS);
    const [opening, continued] = await startAndContinue('claude');
    for (const spec of [opening, continued]) {
      expect(spec.env?.CEZ_COCKPIT_URL).toBe(ADDRESS.origin);
      expect(spec.env?.CEZ_PROJECT_ID).toBe(ADDRESS.projectId);
      expect(spec.systemPrompt).not.toContain(PROMPT_HEADING);
    }
    expect(manager!.builtinSkills()).toEqual([]);
  });

  it.each(RUNNER_IDS)('%s: an addressed manager with automations on composes the part at both sites', async (runner) => {
    process.env.CEZ_AUTOMATIONS = '1';
    manager!.setCockpitAddress(ADDRESS);
    const [opening, continued] = await startAndContinue(runner);
    for (const spec of [opening, continued]) {
      expect(spec.env?.CEZ_COCKPIT_URL).toBe(ADDRESS.origin);
      expect(spec.env?.CEZ_PROJECT_ID).toBe(ADDRESS.projectId);
      expect(spec.systemPrompt).toContain(PROMPT_HEADING);
      expect(spec.systemPrompt).toContain(' automation schema');
    }
    expect(manager!.builtinSkills().map((skill) => skill.name)).toEqual([CREATE_AUTOMATION_SKILL_NAME]);
  });

  // Review of #1018: `serve` recovers the boot project before `startServer` runs, so an address
  // set by the server arrives after recovery has already resumed runs. The address is a
  // constructor option so the boot manager carries it from its first session.
  it('a manager built with its address carries it into the runs recovery resumes', async () => {
    process.env.CEZ_AUTOMATIONS = '1';
    const { id } = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 'do it',
      worktree: false,
      steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
    });
    store.updateRun(id, { workflowDef: TASK_DEF });
    manager!.dispose();
    manager = createFixtureManager(store, repoRoot, { cockpit: ADDRESS });
    await manager.recover();
    const { spec } = await specAt(0);
    expect(spec.env?.CEZ_COCKPIT_URL).toBe(ADDRESS.origin);
    expect(spec.env?.CEZ_PROJECT_ID).toBe(ADDRESS.projectId);
    expect(spec.systemPrompt).toContain(PROMPT_HEADING);
    await settled(id);
  });

  it('clearing the address stops the next session from carrying it', async () => {
    process.env.CEZ_AUTOMATIONS = '1';
    manager!.setCockpitAddress(ADDRESS);
    manager!.setCockpitAddress(undefined);
    const record = manager!.startRun(TASK_DEF, { task: 'do it', worktree: false });
    const { spec } = await specAt(0);
    expect(spec.env?.CEZ_COCKPIT_URL).toBeUndefined();
    expect(spec.systemPrompt).not.toContain(PROMPT_HEADING);
    await settled(record.id);
  });

  it('a task that picks the built-in skill runs its playbook', async () => {
    process.env.CEZ_AUTOMATIONS = '1';
    manager!.setCockpitAddress(ADDRESS);
    const def: WorkflowDef = {
      name: '(planned)',
      source: 'built-in',
      steps: [{ id: 'task', name: CREATE_AUTOMATION_SKILL_NAME, skill: CREATE_AUTOMATION_SKILL_NAME, prompt: '{{task}}' }],
    };
    const record = manager!.startRun(def, { task: 'whenever a PR is opened, review it', worktree: false });
    const { spec } = await specAt(0);
    expect(spec.systemPrompt).toContain('# Create an automation');
    await settled(record.id);
  });

  it('a repo skill of the same name shadows the built-in', async () => {
    process.env.CEZ_AUTOMATIONS = '1';
    manager!.setCockpitAddress(ADDRESS);
    const dir = join(repoRoot, '.ai/skills', CREATE_AUTOMATION_SKILL_NAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${CREATE_AUTOMATION_SKILL_NAME}\ndescription: repo copy\n---\nREPO PLAYBOOK\n`);
    const def: WorkflowDef = {
      name: '(planned)',
      source: 'built-in',
      steps: [{ id: 'task', name: CREATE_AUTOMATION_SKILL_NAME, skill: CREATE_AUTOMATION_SKILL_NAME, prompt: '{{task}}' }],
    };
    const record = manager!.startRun(def, { task: 'x', worktree: false });
    const { spec } = await specAt(0);
    expect(spec.systemPrompt).toContain('REPO PLAYBOOK');
    expect(spec.systemPrompt).not.toContain('# Create an automation');
    await settled(record.id);
  });
});
