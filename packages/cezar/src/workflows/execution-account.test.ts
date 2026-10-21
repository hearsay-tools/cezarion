import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { executionAccount } from './execution-account.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import type { RunManager } from './run.ts';

/** A usage limit closes the account a step RAN on, which a mixed-runner workflow can set apart from
 *  the task-level `runner` (hearsay-tools/cezarion#1236). */
describe('executionAccount', () => {
  const step = (backend: 'claude' | 'codex', profileId?: string) =>
    ({ id: `s-${backend}`, name: 's', kind: 'agent' as const, status: 'failed' as const, iterations: 1, tokensUsed: 0, sessionId: `sess-${backend}`, backend, profileId });

  it('reads the latest session step, not the task-level runner', () => {
    expect(executionAccount({ runner: 'codex', agentProfile: undefined, steps: [step('codex'), step('claude', 'second')] }))
      .toEqual({ runner: 'claude', agentProfile: 'second' });
  });

  it('falls back to the record before any session exists', () => {
    expect(executionAccount({ runner: 'codex', agentProfile: 'work', steps: [] })).toEqual({ runner: 'codex', agentProfile: 'work' });
  });

  it('takes a continuation that switches backend at its word, on the run account', () => {
    expect(executionAccount({ runner: 'codex', agentProfile: undefined, steps: [step('codex', 'other')] }, { backend: 'claude' }))
      .toEqual({ runner: 'claude', agentProfile: undefined });
  });

  it('takes the account a Continue selected on the same backend, which starts a new session', () => {
    expect(executionAccount({ runner: 'codex', agentProfile: 'new', steps: [step('codex', 'old')] }, { backend: 'codex' }))
      .toEqual({ runner: 'codex', agentProfile: 'new' });
  });

  it('takes the account of the session a continuation resumes', () => {
    expect(executionAccount({ runner: 'codex', agentProfile: 'new', steps: [step('codex', 'old')] }, { backend: 'codex', sessionId: 'sess-codex' }))
      .toEqual({ runner: 'codex', agentProfile: 'old' });
  });

  it('prefers a live session\'s own settings', () => {
    expect(executionAccount({ runner: 'codex', agentProfile: undefined, steps: [step('codex')] }, undefined, { runner: 'claude', agentProfile: 'default' }))
      .toEqual({ runner: 'claude', agentProfile: 'default' });
  });
});

describe('account holds read the execution account', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-exec-account-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
  });
  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function heldRun(): string {
    const run = store.createRun({ title: 'held', workflow: 'w', task: 't', runner: 'codex', steps: [{ id: 'claude-step', name: 'c', kind: 'agent' }] });
    store.updateStep(run.id, 'claude-step', { status: 'failed', sessionId: 'sess-1', backend: 'claude' });
    store.updateRun(run.id, { status: 'waiting', autoResumeAt: new Date(Date.now() + 600_000).toISOString() });
    return run.id;
  }

  it('holds the account the limited step ran on', () => {
    heldRun();
    const holds = manager.accountHolds();
    expect([...holds.deadline]).toEqual(['claude:default']);
  });

  it('holds a live session\'s wake by the step it runs, not the task-level runner', () => {
    heldRun();
    const live = store.createRun({ title: 'live', workflow: 'w', task: 't', runner: 'codex', steps: [{ id: 'x', name: 'x', kind: 'agent' }] });
    const engine = manager as unknown as { active: Map<string, unknown>; wakeHeld(run: unknown): boolean };
    engine.active.set(live.id, { delegationSettings: { cwd: repoRoot, runner: 'claude', agentProfile: 'default' } });
    try {
      expect(engine.wakeHeld(store.getRun(live.id))).toBe(true);
      engine.active.set(live.id, { delegationSettings: { cwd: repoRoot, runner: 'codex', agentProfile: 'default' } });
      expect(engine.wakeHeld(store.getRun(live.id))).toBe(false);
    } finally {
      engine.active.delete(live.id);
    }
  });
});

describe('a held wake does not advertise itself to the workspace line', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-held-wake-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
  });
  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('reports only wakes that could leave, so another project\'s eligible wake goes first', () => {
    // Project A holds a wake on a held account and a usable unstarted task; project B an eligible
    // wake. Advertising A's held wake would hand A the freed slot, and A's pump would start its new
    // task ahead of B's started run (hearsay-tools/cezarion#1236).
    const holder = store.createRun({ title: 'holder', workflow: 'w', task: 't', runner: 'claude', steps: [] });
    store.updateRun(holder.id, { status: 'waiting', autoResumeAt: new Date(Date.now() + 600_000).toISOString() });
    const parked = store.createRun({ title: 'parked', workflow: 'w', task: 't', runner: 'claude', steps: [] });
    const engine = manager as unknown as { queue: string[]; waitWakeQueuedAt: Map<string, number>; oldestWakeAt(): number | null };
    engine.queue.push(parked.id);
    engine.waitWakeQueuedAt.set(parked.id, 1);
    try {
      expect(engine.oldestWakeAt()).toBeNull();
      store.updateRun(holder.id, { status: 'failed', finishedAt: new Date().toISOString() });
      expect(engine.oldestWakeAt()).toBe(1);
      // Any blocker `pump()` applies leaves it out too: here, a worktree cleanup in progress.
      const reclaiming = (manager as unknown as { reclaiming: Set<string> }).reclaiming;
      reclaiming.add(parked.id);
      try { expect(engine.oldestWakeAt()).toBeNull(); } finally { reclaiming.delete(parked.id); }
    } finally {
      engine.queue.splice(engine.queue.indexOf(parked.id), 1);
      engine.waitWakeQueuedAt.delete(parked.id);
    }
  });

  it('reads a runnerless wake on the configured default runner, as pump() does', async () => {
    // A legacy record names no runner, so it runs on the configured default. Hard-coding Claude
    // here advertised it while the default account was held (hearsay-tools/cezarion#1236).
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({ defaultRunner: 'codex' }));
    const holder = store.createRun({ title: 'holder', workflow: 'w', task: 't', runner: 'codex', steps: [] });
    store.updateRun(holder.id, { status: 'waiting', autoResumeAt: new Date(Date.now() + 600_000).toISOString() });
    const parked = store.createRun({ title: 'parked', workflow: 'w', task: 't', steps: [] });
    const engine = manager as unknown as { queue: string[]; waitWakeQueuedAt: Map<string, number>; oldestWakeAt(): number | null; pump(): Promise<void> };
    engine.queue.push(parked.id);
    engine.waitWakeQueuedAt.set(parked.id, 1);
    try {
      // Before any pump has read the configuration, the default is unknown: not advertised.
      expect(engine.oldestWakeAt()).toBeNull();
      await engine.pump();
      expect(engine.queue).toContain(parked.id);
      expect(engine.oldestWakeAt()).toBeNull();
    } finally {
      engine.queue.splice(engine.queue.indexOf(parked.id), 1);
      engine.waitWakeQueuedAt.delete(parked.id);
    }
  });
});
