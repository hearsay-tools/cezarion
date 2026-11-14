import { it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { STEP_COMPLETION_CRITERIA } from './harness-parity.testkit.ts';
import { runsOn } from './parity-classes.testkit.ts';
import { checkParityRegistration } from './parity-partition.testkit.ts';
import { describeWorkflowStepCompletionParity } from './workflow-step-completion-parity.testkit.ts';

it('registers every workflow-step-completion case exactly once across its files', () => {
  checkParityRegistration('workflow-step-completion-parity', describeWorkflowStepCompletionParity,
    RUNNER_IDS.flatMap(backend => STEP_COMPLETION_CRITERIA.filter(row => runsOn('workflow-step-completion', row.id, backend)).map(row => `${backend} ${row.id}`)), 5);
});
