import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunResult, AgentSession } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import * as runners from '../core/runner-factory.ts';
import { fixture } from '../delegation/service.testkit.ts';
import { fixtureWorkSettled } from './fixture-cleanup.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

// bound: Git and the manager must have time to launch on a loaded host.
const until = (predicate: () => boolean) => vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 15_000, interval: 10 });

describe('launch disposal routes', { timeout: 30_000 }, () => {
  let f: ReturnType<typeof fixture>;
  const sessions: Array<{ close(fail?: boolean): void }> = [];
  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '1'); vi.stubEnv('CEZ_AUTONAME', '0');
    f = fixture();
    vi.mocked((f.manager as unknown as { pump(): Promise<void> }).pump).mockRestore();
    vi.spyOn(runners, 'createRunner').mockImplementation(backend => ({
      backend: backend ?? 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      interrupt: async () => {}, run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
      startSession: () => {
        let resolve!: (result: AgentRunResult) => void, reject!: (error: Error) => void;
        let open = true;
        const result = new Promise<AgentRunResult>((ok, bad) => { resolve = ok; reject = bad; });
        const close = (fail = false) => { if (!open) return; open = false; if (fail) reject(new Error('session failed')); else resolve({ text: '', toolCalls: [], tokensUsed: 7 }); };
        const session: AgentSession = { result, get open() { return open; }, sendMessage: () => open, sendAgentMessage: () => open ? Promise.resolve() : false, discardQueuedMessages: () => {}, holdsHumanInput: () => false, interrupt: () => {}, end: () => {} };
        sessions.push({ close }); return session;
      },
    }));
  });
  afterEach(async () => {
    for (const session of sessions.splice(0)) session.close();
    await fixtureWorkSettled(f.root);
    await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  });

  it('preserves a delegated run disposed during final save', async () => {
    const run = f.manager.startRun(QUICK_TASK_WORKFLOW, { task: 'test', runner: 'claude', worktree: false });
    await until(() => sessions.length === 1);
    f.store.updateRun(run.id, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    let entered!: () => void, release!: () => void;
    const saving = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const manager = f.manager as unknown as { saveWorktree(...args: unknown[]): Promise<void> };
    const save = manager.saveWorktree.bind(manager);
    vi.spyOn(manager, 'saveWorktree').mockImplementation(async (...args) => {
      if (args[2] === 'run finalize') { entered(); await gate; }
      await save(...args);
    });
    sessions[0]!.close();
    try {
      await saving;
      f.manager.dispose();
    } finally { release(); }
    await fixtureWorkSettled(f.root);
    const record = f.store.getRun(run.id)!;
    expect(record.status).toBe('running');
    expect(record.steps.map(step => step.status)).toEqual(['done']);
  });

  it.each((['fresh', 'continue'] as const).flatMap(path => ['preserve', 'stop', 'finish', 'ordinary', 'failure'].map(outcome => ({ path, outcome }))))('$path $outcome', async ({ path, outcome }) => {
    const run = f.manager.startRun(QUICK_TASK_WORKFLOW, { task: 'test', runner: 'claude', worktree: false });
    await until(() => sessions.length === 1);
    if (path === 'continue') {
      sessions[0]!.close(); await until(() => !f.manager.isActive(run.id));
      expect(f.manager.continueRun(run.id, { text: 'continue' }).ok).toBe(true);
      await until(() => sessions.length === 2);
    }
    f.store.updateRun(run.id, { delegation: outcome === 'ordinary' ? undefined : { role: 'root', permissions: ['spawn'], receipts: [] } });
    if (outcome === 'stop') expect(f.manager.cancel(run.id)).toBeTruthy();
    if (outcome === 'finish') expect(f.manager.finish(run.id)).toBe(true);
    if (outcome === 'ordinary') expect(f.store.getRun(run.id)?.waits?.length ?? 0).toBe(0);
    const eventsBefore = f.store.readEvents(run.id).length;
    f.manager.dispose(); sessions.at(-1)!.close(outcome === 'failure');
    await fixtureWorkSettled(f.root);
    const record = f.store.getRun(run.id)!;
    const preserved = outcome === 'preserve' || outcome === 'failure' || (path === 'fresh' && outcome === 'ordinary');
    expect(record.status).toBe(preserved ? 'running' : outcome === 'stop' ? 'cancelled' : 'done');
    if (outcome === 'preserve' || outcome === 'failure') {
      expect(record.steps.at(-1)?.tokensUsed).toBe(0);
      expect(f.store.readEvents(run.id).slice(eventsBefore).filter(event => event.type === 'session.ended' || event.type === 'session.error')).toEqual([]);
    }
    expect(record.steps.map(step => step.status)).toEqual(path === 'fresh' ? [preserved ? 'running' : outcome === 'stop' ? 'cancelled' : 'done'] : ['done', preserved ? 'running' : outcome === 'stop' ? 'cancelled' : 'done']);
  });
});
