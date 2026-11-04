import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { exemptionFor, FOLLOWUP_CRITERIA } from './harness-parity.testkit.ts';
import { describeWorkflowFollowup, WORKFLOW_FOLLOWUP_GROUPS } from './workflow-followup-cells.testkit.ts';

describe('workflow followup family registration', () => {
  it('registers every runner and row variant exactly once', () => {
    const groups = Object.keys(WORKFLOW_FOLLOWUP_GROUPS) as Array<keyof typeof WORKFLOW_FOLLOWUP_GROUPS>;
    const names: string[] = [];
    const registration = {
      describe: ((_name: string, body: () => void) => body()) as typeof describe,
      it: ((name: string) => { names.push(name); }) as typeof it,
    };
    const expectedFiles = groups.map(group => `workflow-followup-${group}-parity.test.ts`);
    const actualFiles = readdirSync(new URL('.', import.meta.url)).filter(file =>
      file !== 'workflow-followup-parity.test.ts' && file.startsWith('workflow-followup-') && file.endsWith('-parity.test.ts') && !file.startsWith('workflow-followup-codex-'));
    expect(actualFiles.sort()).toEqual(expectedFiles.sort());
    for (const group of groups) {
      const source = readFileSync(new URL(`./workflow-followup-${group}-parity.test.ts`, import.meta.url), 'utf8');
      expect(source).toContain(`describeWorkflowFollowup('${group}');`);
      expect(source.match(/describeWorkflowFollowup\(/g)).toHaveLength(1);
      describeWorkflowFollowup(group, registration);
    }
    const expectedNames = RUNNER_IDS.flatMap(runner => FOLLOWUP_CRITERIA.flatMap(row => {
      const exemption = exemptionFor(row.id, runner);
      if (exemption) return [`${runner} ${row.id} exemption — ${exemption.reason}`];
      const modes = ['H3', 'H4', 'H5'].includes(row.id) ? ['fresh', 'continuation'] : ['fresh'];
      return modes.map(mode => `${runner} ${row.id} ${row.name}${modes.length > 1 ? ` (${mode})` : ''}`);
    }));
    expect(names.sort()).toEqual(expectedNames.sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it('registers mode-less late-start exemptions only in the fresh-owning files', () => {
    const owners: string[] = [];
    const syntheticReason = 'synthetic mode-split exemption';
    const resolveExemption: typeof exemptionFor = (criterion, backend) => {
      if (criterion !== 'H4' && criterion !== 'H5') return exemptionFor(criterion, backend);
      return { ...exemptionFor('H2', 'codex')!, criterion, backend, reason: syntheticReason };
    };
    const groups = Object.keys(WORKFLOW_FOLLOWUP_GROUPS) as Array<keyof typeof WORKFLOW_FOLLOWUP_GROUPS>;
    for (const group of groups) {
      describeWorkflowFollowup(group, {
        describe: ((_name: string, body: () => void) => body()) as typeof describe,
        it: ((name: string) => {
          if (name.endsWith(syntheticReason)) owners.push(`${group}: ${name}`);
        }) as typeof it,
      }, resolveExemption);
    }
    const expected = RUNNER_IDS.flatMap(runner => [
      `late-start-fresh: ${runner} H4 exemption — ${syntheticReason}`,
      `late-ack-fresh: ${runner} H5 exemption — ${syntheticReason}`,
    ]);
    expect(owners.sort()).toEqual(expected.sort());
  });
});
