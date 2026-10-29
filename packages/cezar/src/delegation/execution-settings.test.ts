import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelegationPolicyError } from './policy.ts';
import { fixture } from './service.testkit.ts';

describe('delegation execution settings boundary', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => {
    vi.stubEnv('CEZ_AGENT_MODELS_LOCKED', '0');
    f = fixture();
    vi.stubEnv('CLAUDE_CONFIG_DIR', f.root);
  });
  afterEach(async () => {
    await f.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('passes through a DelegationPolicyError from model validation unchanged', async () => {
    const error = new DelegationPolicyError('incompatible_state', 'catalog unavailable');
    await expect(f.manager.selectDelegationExecutionSettings(f.parent.id, {}, async () => {
      throw error;
    })).rejects.toBe(error);
  });

  it.each([
    { error: new Error('validation unavailable'), message: 'validation unavailable' },
    { error: 'unavailable', message: 'Worker execution selection is unavailable' },
  ])('maps other model validation failures to invalid_input: $message', async ({ error, message }) => {
    await expect(f.manager.selectDelegationExecutionSettings(f.parent.id, {}, async () => {
      throw error;
    })).rejects.toMatchObject({ code: 'invalid_input', message });
  });

  it('refuses a parent with no live session before resolving a selection', async () => {
    vi.mocked(f.manager.delegationExecutionSettings).mockRestore();
    const validate = vi.fn();
    await expect(f.manager.selectDelegationExecutionSettings(f.parent.id, {}, validate))
      .rejects.toMatchObject({ code: 'incompatible_state', message: 'Parent session settings unavailable' });
    expect(validate).not.toHaveBeenCalled();
  });
});
