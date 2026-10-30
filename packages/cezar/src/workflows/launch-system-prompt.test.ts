import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { artifactInstructions } from '../artifacts/lifecycle.ts';
import { automationCliCommand, automationsPrompt } from '../automations/prompts.ts';
import type { AgentRunSpec } from '../core/agent-runner.ts';
import { handoffInstructions } from '../handoff.ts';
import { RunStore } from '../runs/store.ts';
import { registryEntry } from '../runs/webhook.ts';
import { agentWebhooksPrompt, webhookCliCommand } from '../webhooks/prompt.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { registerProject } from '../workspace/projects.ts';
import { agentWebhooks } from '../workspace/webhooks.ts';
import { skillSystemPrompt, type RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Every spec the runner seam receives, and how the stub runner treats a resumed system prompt. */
const launched = vi.hoisted(() => ({
  specs: [] as AgentRunSpec[],
  resume: 'resent' as 'resent' | 'in-thread',
  listeners: new Set<() => void>(),
}));

// What is under test is the system prompt RunManager composes at both session construction
// sites (`runAgentStep` and `runContinuation`), before the runner seam.
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: (backend: string) => ({
    backend,
    systemPromptOnResume: launched.resume,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec) => {
      launched.specs.push(spec);
      for (const listener of launched.listeners) listener();
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

const DIVIDER = '\n\n---\n\n';
const SKILL = { name: 'pin', description: 'Pins the composed system prompt.', body: 'Follow the pinned playbook.' };
const EXTRA = 'Extra system prompt part.';
const DELEGATION = 'Delegation instructions part.';
const WORKFLOW: WorkflowDef = { name: 'pinned', source: 'built-in', steps: [{ id: 'task', skill: SKILL.name, prompt: '{{task}}' }] };

/**
 * hearsay-tools/cezarion#1632: the whole system prompt, byte for byte, at both launch sites, with
 * every part present: the skill playbook, the run's extra prompt, the delegation instructions,
 * automations, project webhooks, the artifact contract and the handoff contract, in that order.
 * The expected text joins the parts directly, so it does not depend on how the sites compose them.
 */
describe('launch system prompt at both sites (#1632)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  let projectId: string;

  beforeEach(async () => {
    launched.specs.length = 0;
    launched.resume = 'resent';
    vi.stubEnv('CEZ_AUTOMATIONS', '1');
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-launch-system-prompt-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/skills', SKILL.name), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/skills', SKILL.name, 'SKILL.md'),
      `---\nname: ${SKILL.name}\ndescription: ${SKILL.description}\n---\n${SKILL.body}\n`, 'utf8');
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    projectId = (await registerProject(repoRoot)).id;
    await mergeWriteWorkspaceConfig((config) => {
      config.projects.find((project) => project.id === projectId)!.webhooks = [{
        id: 'friction', name: 'Friction reports', description: 'Friction you hit with tools.', agent: true,
        url: 'https://friction.example/hook', token: 'never-in-a-prompt', tasks: false,
      }];
    });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
    manager.setCockpitAddress({ origin: 'http://127.0.0.1:5555', projectId });
    manager.setDelegationProvisioner(() => ({ env: {}, instructions: DELEGATION, restrictCrossSessionMessaging: true, revoke: () => {} }));
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    manager?.dispose();
    manager = undefined;
    store.flush();
    await mergeWriteWorkspaceConfig((config) => {
      config.projects = config.projects.filter((project) => project.id !== projectId);
    });
    rmSync(repoRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  /** Resolves when the runner seam has received spec `index`. */
  function specAt(index: number): Promise<AgentRunSpec> {
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(guard); launched.listeners.delete(check); };
      const check = () => { if (launched.specs.length > index) { finish(); resolve(launched.specs[index]!); } };
      // bound: a hang guard only; the runner seam's call ends the wait. Git fixture setup and
      // provisioning take seconds under load, as in agent-webhooks-prompt.test.ts.
      const guard = setTimeout(() => { finish(); reject(new Error(`no launch #${index}`)); }, 15_000);
      launched.listeners.add(check);
      check();
    });
  }

  /** Spies on one launch site, so a test can await the execution it starts. */
  function watch(method: 'execute' | 'runContinuation') {
    return vi.spyOn(manager as unknown as Record<typeof method, (...args: unknown[]) => Promise<void>>, method);
  }

  /** A fresh run, then a Continue of its session: the two launch sites, in that order. */
  async function startAndContinue(): Promise<[AgentRunSpec, AgentRunSpec]> {
    const execute = watch('execute');
    const continuation = watch('runContinuation');
    const record = manager!.startRun(WORKFLOW, { task: 'do it', worktree: false, runner: 'claude', systemPrompt: EXTRA });
    const opening = await specAt(0);
    // The execution's own promise ends after the run settled and left the active set.
    await execute.mock.results[0]!.value;
    store.updateStep(record.id, 'task', { sessionId: 'sess-1', backend: 'claude' });
    expect(manager!.continueRun(record.id, { text: 'keep going' })).toEqual({ ok: true });
    const continued = await specAt(1);
    await continuation.mock.results[0]!.value;
    return [opening, continued];
  }

  /** The parts after the playbook, as the spec's own environment and tools make them. */
  async function tail(spec: AgentRunSpec): Promise<string[]> {
    const webhooks = agentWebhooksPrompt(webhookCliCommand(), agentWebhooks(await registryEntry(projectId, repoRoot)));
    return [
      EXTRA, DELEGATION, automationsPrompt(automationCliCommand()), webhooks!,
      artifactInstructions(spec.env?.CEZ_ARTIFACTS_DIR), handoffInstructions({ tools: !!spec.cezarTools, handoffInjected: true }),
    ];
  }

  const playbook = () => skillSystemPrompt({ ...SKILL, path: join(repoRoot, '.ai/skills', SKILL.name, 'SKILL.md'), source: 'ai' });

  it('a fresh step and a Continue that resends the playbook compose every part in order', async () => {
    const [opening, continued] = await startAndContinue();
    for (const part of await tail(opening)) expect(part.trim()).not.toBe('');
    expect(opening.systemPrompt).toBe([playbook(), ...await tail(opening)].join(DIVIDER));
    expect(continued.systemPrompt).toBe([playbook(), ...await tail(continued)].join(DIVIDER));
    expect(continued.resumeFallbackSystemPrompt).toBeUndefined();
  });

  it('an in-thread Continue leaves the playbook to its fallback system prompt', async () => {
    launched.resume = 'in-thread';
    const [, continued] = await startAndContinue();
    expect(continued.systemPrompt).toBe((await tail(continued)).join(DIVIDER));
    expect(continued.resumeFallbackSystemPrompt).toBe([playbook(), ...await tail(continued)].join(DIVIDER));
  });
});
