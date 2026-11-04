import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withHeldAck, withHeldResponse, withRejectedInput } from './owned-input-delivery.testkit.ts';
import { HARNESS_ADAPTERS } from './harness-parity.testkit.ts';


describe('delivery control wrappers', () => {
  afterEach(() => vi.unstubAllEnvs());
  const wrappers = {
    withRejectedInput: (body: () => Promise<void>) => withRejectedInput('codex', body),
    withHeldAck: (body: () => Promise<void>) => withHeldAck('codex', body),
    withHeldResponse: (body: () => Promise<void>) => withHeldResponse('codex', body),
  };
  it.each(Object.keys(wrappers) as Array<keyof typeof wrappers>)('%s scopes the control to its body and restores the environment', async name => {
    const bin = HARNESS_ADAPTERS.codex.binEnv;
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv(bin, '/prior/codex');
    delete process.env.CEZ_MOCK_DELIVERY_CONTROL;
    const restored = () => {
      expect(process.env.CEZ_MOCK_DELIVERY_CONTROL).toBeUndefined();
      expect(process.env.CEZ_DRY_RUN).toBe('1');
      expect(process.env[bin]).toBe('/prior/codex');
    };
    await wrappers[name](async () => {
      expect(existsSync(process.env.CEZ_MOCK_DELIVERY_CONTROL!)).toBe(true);
      expect(process.env.CEZ_DRY_RUN).toBe('0');
      expect(process.env[bin]).toBe(HARNESS_ADAPTERS.codex.mockBin);
    });
    restored();
    await expect(wrappers[name](async () => { throw new Error('body failed'); })).rejects.toThrow('body failed');
    restored();
  });
});
