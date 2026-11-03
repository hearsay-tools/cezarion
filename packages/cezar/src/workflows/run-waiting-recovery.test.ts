import { createFixtureManager } from './fixture-cleanup.testkit.ts';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../core/agent-runner.ts';
import { registerRunProcess, unregisterRunProcess } from '../core/process-usage.ts';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import { asksQuestion } from '@open-mercato/cezar-contract/waits';
import { WAIT_KIND, WAIT_PHASE, WAIT_VIA, WAIT_SOURCE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { setupMonitoringFixture } from './run-fixture.testkit.ts';
describe('RunManager waiting recovery', () => {
  const fixture = setupMonitoringFixture();
  const { SINGLE_STEP, waitFor } = fixture;
  it('does not Continue or Finish an inactive wait without durable idle-close proof', async () => {
    process.env.CEZ_DRY_RUN = '0';
    process.env.CEZ_CODEX_BIN = join(import.meta.dirname, '../core/__fixtures__/codex/mock-codex-app-server.mjs');
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'plain markerless turn', runner: 'codex', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    const surviving = (fixture.manager as unknown as { active: Map<string, { session?: AgentSession }> }).active.get(record.id)?.session;
    fixture.manager.dispose();
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot);
    await fixture.manager.recover();
    expect(fixture.manager.finish(record.id)).toBe(false);
    expect(fixture.manager.continueRun(record.id, { text: 'resume' })).toEqual({ ok: false, error: 'cannot continue a waiting run' });
    surviving?.end();
  }, 30_000);

  it('does not answer an inactive pending ask while its disposed session process is still registered', async () => {
    process.env.CEZ_DRY_RUN = '0';
    process.env.CEZ_CODEX_BIN = join(import.meta.dirname, '../core/__fixtures__/codex/mock-codex-app-server.mjs');
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'plain markerless turn', runner: 'codex', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    fixture.store.appendEvent(record.id, {
      type: 'ask.requested',
      requestId: 'persisted-question',
      questions: [{
        header: 'Choice',
        question: 'Which implementation?',
        options: [{ label: 'First' }, { label: 'Second' }],
      }],
    });
    const surviving = (fixture.manager as unknown as { active: Map<string, { session?: AgentSession }> }).active.get(record.id)?.session;
    fixture.manager.dispose();
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot);
    await fixture.manager.recover();
    registerRunProcess(record.id, process.pid);

    expect(fixture.manager.continueRun(record.id, { text: 'answer' })).toEqual({
      ok: false,
      error: 'cannot continue a waiting run',
    });
    unregisterRunProcess(record.id);
    surviving?.end();
  }, 30_000);

  it('opens a human wait at recovery for an unanswered ask the record has no wait for', async () => {
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'plain markerless turn', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    fixture.manager.dispose();
    fixture.store.updateRun(record.id, { waits: undefined });
    const ask = fixture.store.appendEvent(record.id, { type: 'ask.requested', requestId: 'legacy-question',
      questions: [{ header: 'Choice', question: 'Which implementation?', options: [{ label: 'First' }, { label: 'Second' }] }] });
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot);
    await fixture.manager.recover();
    const human = fixture.store.getRun(record.id)?.waits?.filter(wait => wait.kind === 'human' && wait.phase === 'open') ?? [];
    expect(human).toEqual([expect.objectContaining({ source: WAIT_SOURCE.agent, askSeq: ask.seq })]);
    expect(fixture.store.getRun(record.id)?.status).toBe('waiting');
    expect(deriveAttention(fixture.store.getRun(record.id)!).label).toBe('needs you');
    expect(fixture.store.readEvents(record.id).filter(event => event.type === 'ask.requested')).toHaveLength(1);
  }, 30_000);

  it('replaces an open Cezar human wait at recovery with the unanswered ask it was not replaced by', async () => {
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'plain markerless turn', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    fixture.manager.dispose();
    const cezar = { id: '00000000-0000-4000-8000-0000000000ac', kind: WAIT_KIND.human, source: WAIT_SOURCE.cezar, via: WAIT_VIA['no-wait'],
      registeredAt: '2026-10-21T00:00:00.000Z', phase: WAIT_PHASE.open, turnId: 'no-wait' };
    fixture.store.updateRun(record.id, { waits: [cezar] });
    const ask = fixture.store.appendEvent(record.id, { type: 'ask.requested', requestId: 'crashed-question',
      questions: [{ header: 'Choice', question: 'Which implementation?', options: [{ label: 'First' }, { label: 'Second' }] }] });
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot);
    await fixture.manager.recover();
    const human = fixture.store.getRun(record.id)?.waits?.filter(wait => wait.kind === 'human' && wait.phase === 'open') ?? [];
    expect(human).toEqual([expect.objectContaining({ source: WAIT_SOURCE.agent, askSeq: ask.seq })]);
    expect(asksQuestion(fixture.store.getRun(record.id)!)).toBe(true);
    expect(fixture.store.readEvents(record.id).filter(event => event.type === 'ask.requested')).toHaveLength(1);
  }, 30_000);

  it('settles an upgraded legacy human wait at recovery when the transcript holds its answer', async () => {
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'plain markerless turn', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    fixture.manager.dispose();
    const ask = fixture.store.appendEvent(record.id, { type: 'ask.requested', requestId: 'answered-question',
      questions: [{ header: 'Choice', question: 'Which implementation?', options: [{ label: 'First' }, { label: 'Second' }] }] });
    fixture.store.appendEvent(record.id, { type: 'human-input-delivered', askSeq: ask.seq });
    const legacy = { id: '00000000-0000-4000-8000-0000000000aa', kind: WAIT_KIND.human, source: WAIT_SOURCE.agent, via: WAIT_VIA['ask-line'],
      registeredAt: '2026-10-21T00:00:00.000Z', phase: WAIT_PHASE.open, turnId: 'legacy' };
    fixture.store.updateRun(record.id, { waits: [legacy] });
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot);
    await fixture.manager.recover();
    expect(fixture.store.getRun(record.id)?.waits?.filter(wait => wait.kind === 'human' && wait.phase === 'open') ?? []).toEqual([]);
    expect(fixture.store.getRun(record.id)?.lastWaits).toEqual(expect.arrayContaining([expect.objectContaining({ id: legacy.id })]));
    expect(fixture.store.readEvents(record.id).filter(event => event.type === 'ask.requested')).toHaveLength(1);
  }, 30_000);

  it('keeps an upgraded legacy human wait at recovery when the transcript facts cannot be read', async () => {
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'plain markerless turn', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    fixture.manager.dispose();
    const legacy = { id: '00000000-0000-4000-8000-0000000000ab', kind: WAIT_KIND.human, source: WAIT_SOURCE.agent, via: WAIT_VIA['ask-line'],
      registeredAt: '2026-10-21T00:00:00.000Z', phase: WAIT_PHASE.open, turnId: 'legacy' };
    fixture.store.updateRun(record.id, { waits: [legacy] });
    const unreadable = vi.spyOn(fixture.store, 'knownTranscriptFacts').mockImplementation(() => undefined);
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot);
    await fixture.manager.recover();
    unreadable.mockRestore();
    expect(fixture.store.getRun(record.id)?.waits).toEqual([expect.objectContaining({ id: legacy.id, phase: WAIT_PHASE.open })]);
  }, 30_000);
});
