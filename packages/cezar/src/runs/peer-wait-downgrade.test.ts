import { describe, expect, it, vi } from 'vitest';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import { waitSchema } from '@open-mercato/cezar-contract/waits';
import { makePeerWait, makeRunRecord, makeTimerWait, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { parseRunRecords } from './store.ts';
import { stateOf } from '../workflows/run-states.ts';

/**
 * What a cezar from before hearsay-tools/cezarion#1995 does with a stored `peer` wait (spec
 * 2026-10-27-task-communication-protocol, Migration; AGENT_PROTOCOL.md § Waits). Its wait union has
 * no `peer` arm, so this file loads the store and the contract with that union in place of today's.
 * hearsay-tools/cezarion#1993 relies on this test for the downgrade note.
 */
vi.mock('@open-mercato/cezar-contract/waits', async importOriginal => {
  const actual = await importOriginal<typeof import('@open-mercato/cezar-contract/waits')>();
  const { z } = await import('zod');
  return { ...actual, waitSchema: z.discriminatedUnion('kind', [actual.prWaitEntrySchema, actual.timerWaitEntrySchema,
    actual.humanWaitEntrySchema, actual.workerWaitEntrySchema, actual.processWaitEntrySchema]) };
});

const stored = (waits: unknown[]) => JSON.parse(JSON.stringify(makeRunRecord({ id: 'downgraded', status: RUN_STATUS.waiting, waits: waits as never })));

describe('an older cezar reading a stored peer wait', () => {
  it('does not know the peer kind', () => {
    expect(waitSchema.safeParse(makePeerWait()).success).toBe(false);
  });

  it('drops the peer wait, keeps the run and its other waits, and records the unreadable wait', () => {
    const timer = makeTimerWait();
    const parsed = parseRunRecords([stored([makePeerWait(), timer])]);
    expect(parsed.success).toBe(true);
    const [run] = parsed.success ? parsed.data : [];
    expect(run?.waits).toEqual([timer]);
    expect(run?.lastWaitsError).toMatch(/unreadable/);
  });

  it('shows a run parked only on a peer wait as Needs you: a plain park', () => {
    const parsed = parseRunRecords([stored([makePeerWait()])]);
    const [run] = parsed.success ? parsed.data : [];
    expect(run?.waits).toBeUndefined();
    expect(stateOf(run!)).toBe('waiting:plain');
    expect(deriveAttention(run!).label).toBe('needs you');
  });
});
