import { it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { SKILL_RESUME_CRITERIA } from './harness-parity.testkit.ts';
import { runsOn } from './parity-classes.testkit.ts';
import { checkParityRegistration } from './parity-partition.testkit.ts';
import { describeSkillResumeParity } from './skill-resume-parity.testkit.ts';

it('registers every skill-resume case exactly once across its files', () => {
  checkParityRegistration('skill-resume-parity', describeSkillResumeParity,
    RUNNER_IDS.flatMap(backend => SKILL_RESUME_CRITERIA.filter(row => runsOn('skill-resume', row.id, backend)).map(row => `${backend} ${row.id}`)), 41);
});
