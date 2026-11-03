import { it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { AUTONOMOUS_CRITERIA } from './harness-parity.testkit.ts';
import { checkParityRegistration } from './parity-partition.testkit.ts';
import { describeWorkflowAutonomousParity } from './workflow-autonomous-parity.testkit.ts';

it('registers every workflow-autonomous case exactly once across its files', () => {
  checkParityRegistration('workflow-autonomous-parity', describeWorkflowAutonomousParity,
    RUNNER_IDS.flatMap(backend => AUTONOMOUS_CRITERIA.map(row => `${backend} ${row.id}`)), 96);
});
