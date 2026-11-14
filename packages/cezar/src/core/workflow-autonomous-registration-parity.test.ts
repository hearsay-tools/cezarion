import { it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { AUTONOMOUS_CRITERIA } from './harness-parity.testkit.ts';
import { runsOn } from './parity-classes.testkit.ts';
import { checkParityRegistration } from './parity-partition.testkit.ts';
import { describeWorkflowAutonomousParity } from './workflow-autonomous-parity.testkit.ts';

it('registers every workflow-autonomous case exactly once across its files', () => {
  checkParityRegistration('workflow-autonomous-parity', describeWorkflowAutonomousParity,
    RUNNER_IDS.flatMap(backend => AUTONOMOUS_CRITERIA.filter(row => runsOn('workflow-autonomous', row.id, backend)).map(row => `${backend} ${row.id}`)), 19);
});
