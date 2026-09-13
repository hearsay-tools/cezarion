import { parseEffort } from '@open-mercato/cezar-contract';
import { DelegationPolicyError } from './policy.ts';

export function parseDelegationEffort(value: string | undefined | null) {
  const parsed = parseEffort(value);
  const trimmed = value?.trim().toLowerCase();
  if (trimmed && trimmed !== 'auto' && parsed === undefined) {
    throw new DelegationPolicyError('invalid_input', 'Invalid effort');
  }
  return parsed;
}
