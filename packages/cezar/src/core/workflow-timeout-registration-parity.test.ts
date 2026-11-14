import { it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { WORKFLOW_TIMEOUT_CRITERIA } from './harness-parity.testkit.ts';
import { runsOn } from './parity-classes.testkit.ts';
import { checkParityRegistration } from './parity-partition.testkit.ts';
import { describeWorkflowTimeoutParity } from './workflow-timeout-parity.testkit.ts';

it('registers every workflow-timeout case exactly once across its files', () => {
  checkParityRegistration('workflow-timeout-parity', describeWorkflowTimeoutParity,
    RUNNER_IDS.flatMap(backend => WORKFLOW_TIMEOUT_CRITERIA.filter(row => runsOn('workflow-timeout', row.id, backend)).map(row => `${backend} ${row.id}`)), 17);
});
