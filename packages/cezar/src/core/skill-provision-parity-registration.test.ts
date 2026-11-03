import { it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { SKILL_PROVISION_CRITERIA } from './harness-parity.testkit.ts';
import { checkParityRegistration } from './parity-partition.testkit.ts';
import { describeSkillProvisionParity } from './skill-provision-parity.testkit.ts';

it('registers every skill-provision case exactly once across its files', () => {
  checkParityRegistration('skill-provision-parity', describeSkillProvisionParity,
    RUNNER_IDS.flatMap(backend => SKILL_PROVISION_CRITERIA.map(row => `${backend} ${row.id}`)), 30);
});
