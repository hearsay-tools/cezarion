import './run-fixture.testkit.ts';
import { runInternals } from './run-internals.testkit.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { RUN_STATUS, STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { crashStore } from '../runs/run-store.testkit.ts';
describe('RunManager.continueRun override', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-continue-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
    // No live agent — we only assert the synchronous persistence continueRun does before it
    // hands off to the (stubbed) continuation.
    (manager as unknown as { runContinuation: () => Promise<void> }).runContinuation = async () => {};
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A finished run with a resumable session on the `claude`/`sonnet` backend. */
  function resumableRun(): string {
    const record = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 't',
      runner: 'claude',
      model: 'sonnet',
      steps: [{ id: 's1', name: 'Work', kind: STEP_KIND.agent }],
    });
    store.updateRun(record.id, { status: RUN_STATUS.done, finishedAt: new Date().toISOString() });
    store.updateStep(record.id, 's1', { sessionId: 'sess-1' });
    return record.id;
  }

  it.each([
    ['immediate', 'account-a', 'account-b'],
    ['capacity', 'account-a', 'account-b'],
    ['immediate', 'default', 'account-b'],
    ['capacity', 'account-a', 'default'],
  ])('preserves account switching through %s Continue recovery (%s to %s)', async (mode, before, after) => {
    const id = resumableRun();
    store.updateRun(id, { agentProfile: before });
    store.updateStep(id, 's1', { profileId: before, backend: 'claude' });
    expect(manager.continueRun(id, {
      text: 'read this with the chosen account', agentProfile: after,
      images: [{ type: 'file', mediaType: 'application/pdf', data: 'YQ==' }],
    }, mode === 'capacity')).toEqual({ ok: true });
    // A crash right after the Continue was accepted: nothing still pending is written.
    manager.dispose(); crashStore(store);
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    manager = createFixtureManager(store, repoRoot);
    const internals = runInternals(manager).line;
    const pump = vi.spyOn(internals, 'pump').mockResolvedValue();
    await manager.recover();
    expect(pump).toHaveBeenCalled();
    expect(runInternals(manager).line.pendingContinuations.get(id)?.prompt).toContain('read this with the chosen account');
    expect(runInternals(manager).line.pendingContinuations.get(id)?.sessionId).toBeUndefined();
    expect(store.getRun(id)?.agentProfile).toBe(after);
  });

  it.each([true, false, undefined])('human Continue preserves saved autonomous=%s (#458)', (autonomous) => {
    const id = resumableRun();
    store.updateRun(id, { autonomous });
    expect(manager.continueRun(id, { text: 'Continue setup' })).toEqual({ ok: true });
    expect(store.getRun(id)?.status).toBe('running');
    expect(store.getRun(id)?.autonomous).toBe(autonomous);
    store.flush();
    expect(RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true }).getRun(id)?.autonomous)
      .toBe(autonomous);
  });

  it('persists a runner + model override as the run current backend', () => {
    const id = resumableRun();
    expect(manager.continueRun(id, { runner: 'codex', model: 'gpt-5.1-codex' })).toEqual({ ok: true });
    const after = store.getRun(id);
    expect(after?.runner).toBe('codex');
    expect(after?.model).toBe('gpt-5.1-codex');
  });

  it('starts fresh when Continue switches to a backend that does not own the session', () => {
    const id = resumableRun();
    const calls: unknown[][] = [];
    (manager as unknown as { runContinuation: (...args: unknown[]) => Promise<void> }).runContinuation = async (...args) => {
      calls.push(args);
    };

    expect(manager.continueRun(id, { runner: 'codex' })).toEqual({ ok: true });
    expect(calls[0]?.[2]).toBeUndefined();
    expect(calls[0]?.[3]).toBe('codex');
  });

  it('resumes when Continue stays on the backend that owns the session', () => {
    const id = resumableRun();
    store.updateStep(id, 's1', { backend: 'claude' });
    const calls: unknown[][] = [];
    (manager as unknown as { runContinuation: (...args: unknown[]) => Promise<void> }).runContinuation = async (...args) => {
      calls.push(args);
    };

    expect(manager.continueRun(id, { runner: 'claude' })).toEqual({ ok: true });
    expect(calls[0]?.[2]).toBe('sess-1');
    expect(calls[0]?.[3]).toBe('claude');
  });

  it('an omitted override preserves the run current backend/model (backward compat)', () => {
    const id = resumableRun();
    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    const after = store.getRun(id);
    expect(after?.runner).toBe('claude');
    expect(after?.model).toBe('sonnet');
  });

  it('persists an effort override and keeps it when Continue omits it (#45)', () => {
    const id = resumableRun();
    store.updateRun(id, { effort: 'medium' });
    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    expect(store.getRun(id)?.effort).toBe('medium');
    // The stub bypasses startup teardown; simulate its completed lifecycle before
    // accepting a second Continue (terminal status alone never proves termination).
    runInternals(manager).line.starting.delete(id);
    store.updateRun(id, { status: RUN_STATUS.done });

    expect(manager.continueRun(id, { effort: 'xhigh' })).toEqual({ ok: true });
    expect(store.getRun(id)?.effort).toBe('xhigh');
  });

  it('an empty effort clears the pin so the harness keeps its default (#45)', () => {
    const id = resumableRun();
    store.updateRun(id, { effort: 'high' });
    expect(manager.continueRun(id, { effort: '' })).toEqual({ ok: true });
    expect(store.getRun(id)?.effort).toBeUndefined();
  });

  it('rejects an effort override while modelsLocked (#45)', () => {
    const id = resumableRun();
    writeFileSync(
      join(repoRoot, '.ai', 'cezar', 'config.json'),
      JSON.stringify({ modelsLocked: true }),
      'utf8',
    );
    const result = manager.continueRun(id, { effort: 'max' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/locked/);
    expect(store.getRun(id)?.effort).toBeUndefined();
  });

  it('a runner-only switch keeps the effort pin — it is shared vocabulary, not per-backend (#45)', () => {
    const id = resumableRun();
    store.updateRun(id, { effort: 'max' });
    expect(manager.continueRun(id, { runner: 'codex' })).toEqual({ ok: true });
    expect(store.getRun(id)?.effort).toBe('max');
  });

  it("an empty model clears the pin so the runner picks the model (auto)", () => {
    const id = resumableRun();
    manager.continueRun(id, { model: '' });
    expect(store.getRun(id)?.model).toBeUndefined();
    // Runner untouched → the run keeps its backend.
    expect(store.getRun(id)?.runner).toBe('claude');
  });

  it("rejects a model that is recognizably another runner's preset (no corruption persisted)", () => {
    const id = resumableRun();
    // The review's corruption case (#401): a codex preset landing on a claude continuation.
    const result = manager.continueRun(id, { model: 'gpt-5.1-codex' });
    expect(result).toEqual({ ok: false, error: "model 'gpt-5.1-codex' is not a claude model" });
    expect(store.getRun(id)?.model).toBe('sonnet');
    expect(store.getRun(id)?.runner).toBe('claude');
  });

  it('a runner-only switch clears the previous backend model pin instead of carrying it over', () => {
    const id = resumableRun(); // claude/sonnet
    // The composer sends only `runner` when the user switches backend without touching the
    // model pill (it displays `auto` at that point). The inherited `sonnet` pin belongs to
    // claude and must not reach the codex runner via `runContinuation`'s `model: record.model`.
    expect(manager.continueRun(id, { runner: 'codex' })).toEqual({ ok: true });
    const after = store.getRun(id);
    expect(after?.runner).toBe('codex');
    expect(after?.model).toBeUndefined();
  });

  it('a runner-only switch keeps a free-form model id — only known foreign presets are cleared', () => {
    const record = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 't',
      runner: 'claude',
      model: 'my-org/custom-tune',
      steps: [{ id: 's1', name: 'Work', kind: STEP_KIND.agent }],
    });
    store.updateRun(record.id, { status: RUN_STATUS.done, finishedAt: new Date().toISOString() });
    store.updateStep(record.id, 's1', { sessionId: 'sess-1' });
    expect(manager.continueRun(record.id, { runner: 'codex' })).toEqual({ ok: true });
    expect(store.getRun(record.id)?.model).toBe('my-org/custom-tune');
  });

  it('a runner-only continue on the SAME backend keeps the pin (no spurious clear)', () => {
    const id = resumableRun(); // claude/sonnet
    expect(manager.continueRun(id, { runner: 'claude' })).toEqual({ ok: true });
    expect(store.getRun(id)?.model).toBe('sonnet');
  });

  it('guards legacy records too — no persisted runner resolves to claude, like runContinuation', () => {
    const record = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [{ id: 's1', name: 'Work', kind: STEP_KIND.agent }] });
    store.updateRun(record.id, { status: RUN_STATUS.done, finishedAt: new Date().toISOString() });
    store.updateStep(record.id, 's1', { sessionId: 'sess-1' });
    const result = manager.continueRun(record.id, { model: 'gpt-5.1-codex' });
    expect(result.ok).toBe(false);
    expect(store.getRun(record.id)?.model).toBeUndefined();
  });

  it('keeps free-form model ids working — only cross-runner presets are rejected', () => {
    const id = resumableRun();
    expect(manager.continueRun(id, { model: 'my-custom-alias' })).toEqual({ ok: true });
    expect(store.getRun(id)?.model).toBe('my-custom-alias');
  });

  /* Agent accounts (spec 2026-07-29-agent-profiles): a follow-up may switch login as well as
     backend — and a session id only resolves inside the config dir that created it. */

  it('persists the picked account as the run current one', () => {
    const id = resumableRun();
    expect(manager.continueRun(id, { agentProfile: 'klaudiusz' })).toEqual({ ok: true });
    expect(store.getRun(id)?.agentProfile).toBe('klaudiusz');
    // Nothing else moves: the account is its own axis.
    expect(store.getRun(id)?.runner).toBe('claude');
    expect(store.getRun(id)?.model).toBe('sonnet');
  });

  it('starts fresh when Continue switches to another login of the same agent', () => {
    const id = resumableRun();
    store.updateStep(id, 's1', { backend: 'claude', profileId: 'default' });
    const calls: unknown[][] = [];
    (manager as unknown as { runContinuation: (...args: unknown[]) => Promise<void> }).runContinuation = async (...args) => {
      calls.push(args);
    };

    expect(manager.continueRun(id, { agentProfile: 'klaudiusz' })).toEqual({ ok: true });
    // `claude --resume <id>` under another login would find nothing and silently open a fresh
    // conversation, so the session id is deliberately not passed.
    expect(calls[0]?.[2]).toBeUndefined();
    expect(calls[0]?.[3]).toBe('claude');
  });

  it('resumes when the picked account is the one that owns the session', () => {
    const id = resumableRun();
    store.updateStep(id, 's1', { backend: 'claude', profileId: 'klaudiusz' });
    const calls: unknown[][] = [];
    (manager as unknown as { runContinuation: (...args: unknown[]) => Promise<void> }).runContinuation = async (...args) => {
      calls.push(args);
    };

    expect(manager.continueRun(id, { agentProfile: 'klaudiusz' })).toEqual({ ok: true });
    expect(calls[0]?.[2]).toBe('sess-1');
  });

  it('treats a step that recorded no account as the discovered one', () => {
    // Pre-accounts sessions ran under whatever `agentHomePaths()` finds, so re-picking `default`
    // is not a switch and must still resume.
    const id = resumableRun();
    store.updateStep(id, 's1', { backend: 'claude' });
    const calls: unknown[][] = [];
    (manager as unknown as { runContinuation: (...args: unknown[]) => Promise<void> }).runContinuation = async (...args) => {
      calls.push(args);
    };

    expect(manager.continueRun(id, { agentProfile: 'default' })).toEqual({ ok: true });
    expect(calls[0]?.[2]).toBe('sess-1');
  });

  it('an omitted account preserves the one the run is on (backward compat)', () => {
    const id = resumableRun();
    store.updateRun(id, { agentProfile: 'klaudiusz' });
    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    expect(store.getRun(id)?.agentProfile).toBe('klaudiusz');
  });

  it('a runner switch drops the previous agent account instead of carrying it over', () => {
    // An account belongs to ONE agent: a claude login says nothing about which codex account
    // should run, and leaving it on the record would re-apply it if a later Continue switched back.
    const id = resumableRun();
    store.updateRun(id, { agentProfile: 'klaudiusz' });
    expect(manager.continueRun(id, { runner: 'codex' })).toEqual({ ok: true });
    expect(store.getRun(id)?.agentProfile).toBeUndefined();
  });

  it('keeps the account when the continuation stays on the same agent', () => {
    const id = resumableRun();
    store.updateRun(id, { agentProfile: 'klaudiusz' });
    expect(manager.continueRun(id, { runner: 'claude' })).toEqual({ ok: true });
    expect(store.getRun(id)?.agentProfile).toBe('klaudiusz');
  });

  it('refuses to continue a run with no resumable session (no override persisted)', () => {
    const record = store.createRun({ title: 't', workflow: 'quick-task', task: 't', runner: 'claude', steps: [] });
    store.updateRun(record.id, { status: RUN_STATUS.done });
    const result = manager.continueRun(record.id, { runner: 'codex' });
    expect(result.ok).toBe(false);
    expect(store.getRun(record.id)?.runner).toBe('claude');
  });
});
