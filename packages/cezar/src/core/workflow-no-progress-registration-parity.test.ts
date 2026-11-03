import { it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { NO_PROGRESS_CRITERIA } from './harness-parity.testkit.ts';
import { checkParityRegistration } from './parity-partition.testkit.ts';
import { describeWorkflowNoProgressParity } from './workflow-no-progress-parity.testkit.ts';

it('registers every workflow-no-progress case exactly once across its files', () => {
  checkParityRegistration('workflow-no-progress-parity', describeWorkflowNoProgressParity,
    RUNNER_IDS.flatMap(backend => NO_PROGRESS_CRITERIA.map(row => `${backend} ${row.id}`)), 48);
});
