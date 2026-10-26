import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { runStatusSchema, stepStateSchema, stepStatusSchema } from '@open-mercato/cezar-contract/runs';
import { timerWaitEntrySchema, waitPhaseSchema, waitSchema, waitViaSchema } from '@open-mercato/cezar-contract/waits';
import { ruleTestsDir, rulesDir } from './ast-grep-rules.testkit.ts';

/**
 * The `test-enum-literal` rules hold the contract's enum values as regexes in YAML, which no type
 * checks (hearsay-tools/cezarion#1812). A value the contract adds would then escape the rule
 * unseen, and a rule that matched nothing would look like a clean repository. This test derives
 * each key's values from the schemas and holds the rule to them.
 */

interface Util { has: { regex: string } }
interface RuleFile { message: string; utils: Record<string, Util>; rule: unknown }

const read = (id: string): RuleFile => parse(readFileSync(join(rulesDir, `${id}.yml`), 'utf8')) as RuleFile;

/** The object keys the rule reads, each with the values of the contract enum behind it. */
const CONTRACT_VALUES: Record<string, string[]> = {
  status: [...runStatusSchema.options, ...stepStatusSchema.options],
  kind: [...waitSchema.options.map((entry) => entry.shape.kind.value), ...stepStateSchema.shape.kind.options],
  phase: [...waitPhaseSchema.options],
  via: [...waitViaSchema.options],
  source: [...timerWaitEntrySchema.shape.source.options],
};

function valuesOf(util: Util): string[] {
  const alternatives = /^\^\((.*)\)\$$/.exec(util.has.regex)?.[1] ?? '';
  return alternatives.split('|');
}

function globsOf(id: string): string[] {
  const rule = parse(readFileSync(join(rulesDir, `${id}.yml`), 'utf8')) as { files: string[] };
  return rule.files;
}

const unique = (values: string[]): string[] => [...new Set(values)].sort();

describe('the test-enum-literal rules', () => {
  const ts = read('test-enum-literal');

  it('hold each key to the values of the contract enum behind it', () => {
    expect(Object.keys(ts.utils).sort()).toEqual(Object.keys(CONTRACT_VALUES).map((key) => `${key}-literal`).sort());
    for (const [key, values] of Object.entries(CONTRACT_VALUES)) {
      const util = ts.utils[`${key}-literal`];
      expect(util, `${key}-literal`).toBeDefined();
      expect(unique(valuesOf(util!)), `values of ${key}: a contract value is missing from the rule, or the rule holds one the contract dropped`).toEqual(unique(values));
    }
  });

  it('have a rule-tests snippet that must match for every key and value, so the rule uses each regex', () => {
    const { invalid } = parse(readFileSync(join(ruleTestsDir, 'test-enum-literal-test.yml'), 'utf8')) as { invalid: string[] };
    for (const [key, values] of Object.entries(CONTRACT_VALUES)) {
      for (const value of values) expect(invalid, `no invalid snippet for ${key}: '${value}'`).toContain(`const x = { ${key}: '${value}' }`);
    }
  });

  it('keep the .ts and .tsx rules the same apart from their grammar and files', () => {
    const tsx = read('test-enum-literal-tsx');
    expect(tsx.rule).toEqual(ts.rule);
    expect(tsx.utils).toEqual(ts.utils);
    expect(tsx.message).toBe(ts.message);
  });

  it('name no file twice between the two grammars', () => {
    expect(globsOf('test-enum-literal').every((glob) => !glob.endsWith('.tsx'))).toBe(true);
    expect(globsOf('test-enum-literal-tsx').every((glob) => glob.endsWith('.tsx'))).toBe(true);
  });
});
