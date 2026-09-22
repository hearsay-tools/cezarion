import { describe, expect, it } from 'vitest';
import { ciWaitRequestSchema, ciWaitSchema, ciWaitResultSchema, ciWaitReceiptSchema } from '@open-mercato/cezar-contract';

describe('CI wait contract', () => {
  it('defaults timeout and rejects model-supplied authority and malformed PR URLs', () => {
    expect(ciWaitRequestSchema.parse({ pr: 'https://github.com/org/repo/pull/12' })).toEqual({ pr: 'https://github.com/org/repo/pull/12', timeout_seconds: 1800 });
    for (const pr of ['http://github.com/a/b/pull/1', 'https://user@github.com/a/b/pull/1', 'https://github.com:443/a/b/pull/1', 'https://github.com/a/b/pull/0', 'https://github.com/a/b/pull/1?q=x', 'https://github.com/a/b/pull/1#x', 'https://github.com/a/b/pull/1/', 'https://github.com/a/b/pull/9007199254740993']) {
      expect(ciWaitRequestSchema.safeParse({ pr }).success, pr).toBe(false);
    }
    for (const timeout_seconds of [0, 7201, 1.5]) expect(ciWaitRequestSchema.safeParse({ pr: 'https://github.com/a/b/pull/1', timeout_seconds }).success).toBe(false);
    expect(ciWaitRequestSchema.safeParse({ pr: 'https://github.com/a/b/pull/1', runId: 'elsewhere' }).success).toBe(false);
  });
  it('bounds persisted results and does not salvage malformed state as successful CI', () => {
    expect(ciWaitSchema.safeParse({ phase: 'registered' }).success).toBe(false);
    expect(ciWaitResultSchema.safeParse({ outcome: 'passed', headSha: 'a'.repeat(40), observedAt: new Date().toISOString(), checks: Array.from({length:101}, () => ({name:'check',state:'SUCCESS',link:''})), totalChecks:101, truncated:false }).success).toBe(false);
  });
});

it('rejects a persisted result larger than the total 32 KiB wire budget', () => {
  expect(ciWaitResultSchema.safeParse({ outcome:'passed',headSha:'a'.repeat(40),observedAt:new Date().toISOString(),checks:Array.from({length:100},()=>({name:'build',state:'SUCCESS',link:'https://example.com/'+ 'x'.repeat(2000)})),totalChecks:100,truncated:false }).success).toBe(false);
});


it('returns a bounded wire receipt without persisted authority or delivery state', () => {
  const receipt = {
    waitId: '4a6b6bf4-798c-4dc7-aede-e583428f667a',
    prUrl: 'https://github.com/org/repo/pull/12',
    repository: 'org/repo',
    prNumber: 12,
    headSha: 'a'.repeat(40),
    registeredAt: '2026-09-22T13:00:00.000Z',
    deadline: '2026-09-22T13:30:00.000Z',
    phase: 'registered',
  };
  expect(ciWaitReceiptSchema.safeParse(receipt).success).toBe(true);
  expect(ciWaitReceiptSchema.parse(receipt)).toEqual(receipt);
  for (const privateState of [
    { id: receipt.waitId },
    { generation: 'session-generation' },
    { turnId: 'originating-turn' },
    { wakeId: 'delivery-input' },
    { deliveredAt: receipt.deadline },
  ]) {
    expect(ciWaitReceiptSchema.safeParse({ ...receipt, ...privateState }).success).toBe(false);
  }
  const { waitId, ...identity } = receipt;
  expect(ciWaitSchema.safeParse({ ...identity, id: waitId, generation: 'session-generation', turnId: 'originating-turn', timeoutSeconds: 1800 }).success).toBe(true);
});
