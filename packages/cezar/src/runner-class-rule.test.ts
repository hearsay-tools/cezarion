import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { expect, it } from 'vitest';
import { repoRoot, rulesDir } from './ast-grep-rules.testkit.ts';

/**
 * The `runner-class-outside-factory` rule holds the runner class names and the runner module
 * name shape as regexes in YAML, which no type checks. A runner class added to `core/` would
 * escape the rule unseen. This test derives both from the classes that implement `AgentRunner`.
 */

interface RuleFile {
  utils: {
    'runner-class-name': { regex: string };
    'runner-module': { all: [unknown, { has: { regex: string } }, { not: { has: { regex: string } } }] };
  };
}

const rule = parse(readFileSync(join(rulesDir, 'runner-class-outside-factory.yml'), 'utf8')) as RuleFile;
const coreDir = join(repoRoot, 'packages/cezar/src/core');

/** Every class in a non-test `core/` source that implements `AgentRunner`, with its file. */
const runnerClasses = readdirSync(coreDir)
  .filter((file) => file.endsWith('.ts') && !/\.(test|testkit)\.ts$/.test(file))
  .flatMap((file) => [...readFileSync(join(coreDir, file), 'utf8').matchAll(/\bclass\s+(\w+)\s+implements\s+AgentRunner\b/g)]
    .map((match) => ({ file, name: match[1]! })));

it('names every class that implements AgentRunner, and no other', () => {
  const named = /^\^\((.*)\)\$$/.exec(rule.utils['runner-class-name'].regex)?.[1]?.split('|') ?? [];
  expect(runnerClasses.length).toBeGreaterThan(0);
  expect([...named].sort()).toEqual(runnerClasses.map((entry) => entry.name).sort());
});

it('matches the module of every runner class, and not the interface module', () => {
  const [, { has }, { not }] = rule.utils['runner-module'].all;
  const concrete = (specifier: string): boolean => new RegExp(has.regex).test(specifier) && !new RegExp(not.has.regex).test(specifier);
  for (const { file, name } of runnerClasses) expect(concrete(`../core/${file}`), `${name} in core/${file}`).toBe(true);
  expect(concrete('../core/agent-runner.ts')).toBe(false);
  expect(concrete('../core/runner-factory.ts')).toBe(false);
});
