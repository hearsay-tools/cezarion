import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { FOLLOWUP_CRITERIA } from './harness-parity.testkit.ts';
import { describeWorkflowFollowup, WORKFLOW_FOLLOWUP_GROUPS } from './workflow-followup-cells.testkit.ts';

describe('workflow followup family registration', () => {
  it('registers every runner and row variant exactly once', () => {
    const groups = Object.keys(WORKFLOW_FOLLOWUP_GROUPS) as Array<keyof typeof WORKFLOW_FOLLOWUP_GROUPS>;
    const rows = groups.flatMap(group => [...WORKFLOW_FOLLOWUP_GROUPS[group]]);
    expect([...rows].sort()).toEqual(FOLLOWUP_CRITERIA.map(row => row.id).sort());
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
    expect(new Set(names).size).toBe(names.length);
    for (const runner of RUNNER_IDS) for (const row of FOLLOWUP_CRITERIA) {
      const expectedModes = ['H3', 'H4', 'H5'].includes(row.id) && !names.some(name => name.startsWith(`${runner} ${row.id} exemption`)) ? 2 : 1;
      expect(names.filter(name => name.startsWith(`${runner} ${row.id} `))).toHaveLength(expectedModes);
    }
  });
});
