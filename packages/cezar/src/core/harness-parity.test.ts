import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { describeHarnessParity, HARNESS_PARITY_GROUPS, harnessParityFile, harnessParityRegistrations, type HarnessParityPart } from './harness-parity-cells.testkit.ts';

import { describeAutosaveChurn, describeAutosaveSettlement } from './harness-autosave-settlement.testkit.ts';

// Matrix guards and single-runner checks stay in this file.
describeHarnessParity('once');

describe('harness parity part registration', () => {
  it('registers every criterion and runner exactly once across its part files', () => {
    const parts = Object.keys(HARNESS_PARITY_GROUPS) as HarnessParityPart[];
    const expectedFiles = RUNNER_IDS.flatMap(runner => parts.map(part => harnessParityFile(runner, part)));
    const actualFiles = readdirSync(new URL('.', import.meta.url)).filter(file =>
      RUNNER_IDS.some(runner => file.startsWith(`harness-${runner}-`) && file.endsWith('-parity.test.ts')));
    expect(actualFiles.sort()).toEqual(expectedFiles.sort());
    for (const runner of RUNNER_IDS) {
      const all = harnessParityRegistrations(runner);
      const routed = parts.map(part => harnessParityRegistrations(runner, part));
      // Full names also pin each variant of a criterion (permission decisions, fresh/Continue).
      expect(routed.flat().sort(), runner).toEqual([...all].sort());
      expect(new Set(all).size, runner).toBe(all.length);
      const owners = new Map<string, Set<HarnessParityPart>>();
      for (const [index, names] of routed.entries()) for (const name of names) {
        const criterion = name.match(/\b(?:S|R|I|P|D|PR)\d+\b/)?.[0] ?? name;
        const entry = owners.get(criterion) ?? new Set<HarnessParityPart>();
        entry.add(parts[index]!);
        owners.set(criterion, entry);
      }
      for (const [criterion, entries] of owners) expect(entries.size, `${runner}/${criterion}`).toBe(1);
    }
  });
});

describe('harness autosave settlement part registration', () => {
  it('registers each R61–R68 runner pair in exactly one family file', () => {
    const names: string[] = [];
    const registration = {
      describe: ((_name: string, body: () => void) => body()) as typeof describe,
      it: ((name: string) => { names.push(name); }) as typeof it,
    };
    for (const [suffix, outcome] of [['', 'failed'], ['-success', 'success']] as const) {
      const source = readFileSync(new URL(`./harness-autosave-settlement${suffix}.test.ts`, import.meta.url), 'utf8');
      expect(source).toContain(`describeAutosaveSettlement('${outcome}');`);
      expect(source.match(/describeAutosaveSettlement\(/g)).toHaveLength(1);
      describeAutosaveSettlement(outcome, registration);
    }
    for (const suffix of ['-cancel', '-cancel-continue']) {
      const source = readFileSync(new URL(`./harness-autosave-settlement${suffix}.test.ts`, import.meta.url), 'utf8');
      expect(source.match(/describeAutosaveSettlement\(/g)).toHaveLength(1);
      const calls = [...source.matchAll(/describeAutosaveSettlement\('cancelled', undefined, \[(true|false)\]\);/g)];
      expect(calls).toHaveLength(1);
      for (const call of calls) describeAutosaveSettlement('cancelled', registration, [call[1] === 'true']);
    }
    const churn = readFileSync(new URL('./harness-autosave-settlement-churn.test.ts', import.meta.url), 'utf8');
    expect(churn.match(/describeAutosaveChurn\(/g)).toHaveLength(1);
    describeAutosaveChurn(registration);
    const pairs = names.map(name => name.match(/^(\w+) (R\d+) /)!.slice(1).join('/'));
    expect(pairs.sort()).toEqual(RUNNER_IDS.flatMap(runner =>
      Array.from({ length: 8 }, (_, index) => `${runner}/R${61 + index}`)).sort());
  });
});
