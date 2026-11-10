import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { expect, it } from 'vitest';
import { rulesDir, runAstGrep } from './ast-grep-rules.testkit.ts';

const ruleSchema = z.object({ ignores: z.array(z.string()) }).passthrough();
const matchesSchema = z.array(z.object({ file: z.string() }));
const rule = ruleSchema.parse(parse(readFileSync(join(rulesDir, 'wait-kind-literal-outside-engine.yml'), 'utf8')));
const allowList = rule.ignores.filter((file) => !file.includes('*'));

it('keeps a wait-kind match in every allow-listed production file', async () => {
  expect(allowList.length).toBeGreaterThan(0);
  const run = await runAstGrep([
    'scan', '--inline-rules', stringify({ ...rule, ignores: [] }), '--json=compact', ...allowList,
  ]);
  expect(run.code, run.stderr).toBe(0);
  const matches = matchesSchema.parse(JSON.parse(run.stdout));
  const matchedFiles = new Set(matches.map((match) => match.file));
  for (const file of allowList) {
    expect(matchedFiles.has(file), `${file} has no wait-kind literal: remove its stale allow-list entry`).toBe(true);
  }
// bound: the shared ast-grep process guard is 100 s; leave time for it to report a hang.
}, 120_000);
