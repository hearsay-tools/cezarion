import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { WORKFLOW_ASK_CRITERIA } from './harness-parity.testkit.ts';
import { describeWorkflowAsk, WORKFLOW_ASK_GROUPS } from './workflow-ask-cells.testkit.ts';

describe('workflow ask family registration', () => {
  it('registers every runner and row variant exactly once', () => {
    const groups = Object.keys(WORKFLOW_ASK_GROUPS) as Array<keyof typeof WORKFLOW_ASK_GROUPS>;
    const rows = groups.flatMap(group => [...WORKFLOW_ASK_GROUPS[group]]);
    expect([...rows].sort()).toEqual(WORKFLOW_ASK_CRITERIA.map(row => row.id).sort());
    const names: string[] = [];
    const registration = {
      afterEach: (() => {}) as typeof afterEach,
      describe: ((_name: string, body: () => void) => body()) as typeof describe,
      it: ((name: string) => { names.push(name); }) as typeof it,
    };
    const expectedFiles = groups.map(group => `workflow-ask-${group}-parity.test.ts`);
    const actualFiles = readdirSync(new URL('.', import.meta.url)).filter(file =>
      file !== 'workflow-ask-parity.test.ts' && file.startsWith('workflow-ask-') && file.endsWith('-parity.test.ts'));
    expect(actualFiles.sort()).toEqual(expectedFiles.sort());
    for (const group of groups) {
      const source = readFileSync(new URL(`./workflow-ask-${group}-parity.test.ts`, import.meta.url), 'utf8');
      expect(source).toContain(`describeWorkflowAsk('${group}');`);
      expect(source.match(/describeWorkflowAsk\(/g)).toHaveLength(1);
      describeWorkflowAsk(group, registration);
    }
    expect(new Set(names).size).toBe(names.length);
    for (const runner of RUNNER_IDS) for (const row of WORKFLOW_ASK_CRITERIA) {
      expect(names.filter(name => name.startsWith(`${runner} ${row.id} `))).toHaveLength(1);
    }
  });
});
