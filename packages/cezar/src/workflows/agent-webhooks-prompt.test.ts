import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSpec } from '../core/agent-runner.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { registerProject } from '../workspace/projects.ts';
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

const HEADING = '## Project webhooks';
const TASK_DEF: WorkflowDef = { name: 'quick-task', source: 'built-in', steps: [{ id: 'task', prompt: '{{task}}' }] };

/**
 * The "Project webhooks" part (hearsay-tools/cezarion#1576): an addressed manager lists the
 * webhooks its project exposes to agents, at both session construction sites; nothing exposed,
 * or no cockpit to send through, composes nothing.
 */
describe('agent webhooks prompt part (#1576)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  let projectId: string;

  beforeEach(async () => {
    captured.specs.length = 0;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-webhooks-prompt-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    projectId = (await registerProject(repoRoot)).id;
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
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
  });

  const setWebhooks = (webhooks: Array<{ id: string; name: string; description?: string; agent: boolean }>) =>
    mergeWriteWorkspaceConfig((config) => {
      config.projects.find((project) => project.id === projectId)!.webhooks = webhooks.map((webhook) => ({
        ...webhook, url: `https://${webhook.id}.example/hook`, token: 'never-in-a-prompt', tasks: false,
      }));
    });

  async function specAt(index: number): Promise<AgentRunSpec> {
    await expect.poll(() => captured.specs.length, { timeout: 15_000 }).toBeGreaterThan(index);
    return captured.specs[index]!.spec;
  }

  async function settled(runId: string): Promise<void> {
    await expect
      .poll(() => store.getRun(runId)?.status, { timeout: 15_000 })
      .toSatisfy((status) => ['done', 'review', 'failed', 'cancelled'].includes(String(status)));
  }

  /** A fresh run, then a Continue of it: the two construction sites, in that order. */
  async function startAndContinue(): Promise<[AgentRunSpec, AgentRunSpec]> {
    const record = manager!.startRun(TASK_DEF, { task: 'do it', worktree: false, runner: 'claude' });
    const opening = await specAt(0);
    await settled(record.id);
    store.updateStep(record.id, 'task', { sessionId: 'sess-1', backend: 'claude' });
    expect(manager!.continueRun(record.id, { text: 'keep going' })).toEqual({ ok: true });
    const continued = await specAt(1);
    await settled(record.id);
    return [opening, continued];
  }

  it('lists the exposed webhooks by name and description, with the send command, at both sites', async () => {
    await setWebhooks([
      { id: 'friction', name: 'Friction reports', description: 'Friction you hit with tools.\nNot GitHub issues.', agent: true },
      { id: 'tasks', name: 'Task bot', agent: false },
    ]);
    manager!.setCockpitAddress({ origin: 'http://127.0.0.1:5555', projectId });
    for (const spec of await startAndContinue()) {
      expect(spec.systemPrompt).toContain(HEADING);
      expect(spec.systemPrompt).toContain('- "Friction reports": Friction you hit with tools. Not GitHub issues.');
      expect(spec.systemPrompt).toContain(' webhook send ');
      expect(spec.systemPrompt).not.toContain('Task bot');
      expect(spec.systemPrompt).not.toContain('friction.example');
      expect(spec.systemPrompt).not.toContain('never-in-a-prompt');
    }
  });

  it('composes nothing when no webhook is exposed to agents', async () => {
    await setWebhooks([{ id: 'tasks', name: 'Task bot', agent: false }]);
    manager!.setCockpitAddress({ origin: 'http://127.0.0.1:5555', projectId });
    for (const spec of await startAndContinue()) expect(spec.systemPrompt ?? '').not.toContain(HEADING);
  });

  it('composes nothing without a cockpit to send through (headless `cez run`)', async () => {
    await setWebhooks([{ id: 'friction', name: 'Friction reports', agent: true }]);
    for (const spec of await startAndContinue()) expect(spec.systemPrompt ?? '').not.toContain(HEADING);
  });
});
