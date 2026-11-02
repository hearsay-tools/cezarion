import { describe, expect, it, vi } from 'vitest';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import { waitSchema } from '@open-mercato/cezar-contract/waits';
import { makeRunRecord, makeSubagentWait, makeTimerWait, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { parseRunRecords } from './store.ts';
import { stateOf } from '../workflows/run-states.ts';

/**
 * What a cezar from before hearsay-tools/cezarion#2431 does with a stored `subagent` wait
 * (AGENT_PROTOCOL.md § Waits). Its wait union has no `subagent` arm, so this file loads the store
 * and the contract with that union in place of today's.
 */
vi.mock('@open-mercato/cezar-contract/waits', async importOriginal => {
  const actual = await importOriginal<typeof import('@open-mercato/cezar-contract/waits')>();
  const { z } = await import('zod');
  return { ...actual, waitSchema: z.discriminatedUnion('kind', [actual.prWaitEntrySchema, actual.timerWaitEntrySchema,
    actual.humanWaitEntrySchema, actual.workerWaitEntrySchema, actual.processWaitEntrySchema, actual.peerWaitEntrySchema]) };
});

const stored = (waits: unknown[]) => JSON.parse(JSON.stringify(makeRunRecord({ id: 'downgraded', status: RUN_STATUS.waiting, waits: waits as never })));

describe('an older cezar reading a stored subagent wait', () => {
  it('does not know the subagent kind', () => {
    expect(waitSchema.safeParse(makeSubagentWait()).success).toBe(false);
  });

  it('drops the subagent wait, keeps the run and its other waits, and records the unreadable wait', () => {
    const timer = makeTimerWait();
    const parsed = parseRunRecords([stored([makeSubagentWait(), timer])]);
    expect(parsed.success).toBe(true);
    const [run] = parsed.success ? parsed.data : [];
    expect(run?.waits).toEqual([timer]);
    expect(run?.lastWaitsError).toMatch(/unreadable/);
  });

  it('shows a run parked only on a subagent wait as Needs you: a plain park', () => {
    const parsed = parseRunRecords([stored([makeSubagentWait()])]);
    const [run] = parsed.success ? parsed.data : [];
    expect(run?.waits).toBeUndefined();
    expect(stateOf(run!)).toBe('waiting:plain');
    expect(deriveAttention(run!).label).toBe('needs you');
  });
});
