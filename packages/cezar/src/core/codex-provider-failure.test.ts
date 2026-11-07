import { STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { describe, expect, it } from 'vitest';
import { driveSeam } from './harness-parity.testkit.ts';
import { driveRun } from './workflow-parity.testkit.ts';

describe('Codex 0.147 provider completion (#83)', () => {
  it('surfaces the provider 400 before the v1 turn boundary and marks v2 as error', async () => {
    const { v1, v2 } = await driveSeam('codex', 'provider-error');
    const error = v1.find((event) => event.type === 'error');
    expect(error?.message ?? '').toContain('"status":400');
    expect(error?.message ?? '').toContain("The 'gpt-6-astra' model requires a newer version of Codex.");
    expect(v1.indexOf(error!)).toBeLessThan(v1.findIndex((event) => event.type === 'turn-end'));
    expect(v2).toContainEqual({ type: 'turn.completed', turnId: 'turn_mock_1', stopReason: 'error' });
  });

  it('fails the step and run and persists the provider message without parking', async () => {
    const obs = await driveRun('codex', 'provider-error',
      (record) => ['failed', 'waiting', 'done', 'review'].includes(record?.status ?? ''));
    expect(obs.record?.status).toBe('failed');
    expect(obs.statuses).not.toContain('waiting');
    expect(obs.events).toContainEqual(expect.objectContaining({ type: 'step-end', status: STEP_STATUS.failed }));
    expect(obs.events).toContainEqual(expect.objectContaining({
      type: 'error', message: expect.stringContaining('"status":400'),
    }));
    expect(obs.events).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'error' }));
  });

  it.each(['mock:empty-success', 'check the working tree'])('keeps markerless success waiting: %s', async (prompt) => {
    const obs = await driveRun('codex', { prompt },
      (record) => ['failed', 'waiting', 'done', 'review'].includes(record?.status ?? ''));
    expect(obs.record?.status).toBe('waiting');
    expect(obs.events.some((event) => event.type === 'error')).toBe(false);
    expect(obs.events).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'end_turn' }));
  });
});
