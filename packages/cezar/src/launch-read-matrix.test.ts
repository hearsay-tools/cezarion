import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { expect, it } from 'vitest';
import { repoRoot, rulesDir, ruleTestsDir, runAstGrep } from './ast-grep-rules.testkit.ts';

const require = createRequire(import.meta.url);
interface LimitCell { family: string; axes: string[]; code: string; reason: string }
interface Matrix { generated: Record<string, { valid: string[]; invalid: string[] }>; documentedLimits: LimitCell[] }
const { generated, documentedLimits } = require('../../../.ai/ast-grep/generate-launch-read-matrix.cjs') as Matrix;
const { renderRule, generate } = require('../../../.ai/ast-grep/generate-launch-read-normalization.cjs') as {
  generate: (check: boolean) => boolean;
  renderRule: (family: string, rule: Record<string, unknown>) => string;
};
const EXPECTED_LIMIT_CELLS = 3456;
const globals = Object.fromEntries(readdirSync(join(repoRoot, '.ai/ast-grep/utils')).map(file => {
  const doc = parse(readFileSync(join(repoRoot, '.ai/ast-grep/utils', file), 'utf8'));
  return [doc.id, doc.rule];
}));

function ruleNames(family: string): string[] {
  const prefix = `launch-read-outside-resolver-${family}`;
  return readdirSync(rulesDir).filter(file => file === `${prefix}.yml` || file.startsWith(`${prefix}-`));
}

function writeCells(directory: string, family: string) {
  mkdirSync(directory);
  const curated = ruleNames(family).map(file => parse(readFileSync(join(ruleTestsDir, file.replace(/\.yml$/, '-test.yml')), 'utf8')));
  const cells = [
    ...[...new Set([...generated[family]!.valid, ...curated.flatMap(c => c.valid as string[])])].map(code => ({ kind: 'valid', code })),
    ...[...new Set([...generated[family]!.invalid, ...curated.flatMap(c => c.invalid as string[])])].map(code => ({ kind: 'invalid', code })),
    ...documentedLimits.filter(cell => cell.family === family).map(cell => ({ kind: 'limit', code: cell.code })),
  ];
  cells.forEach((cell, index) => writeFileSync(join(directory, `${index}.ts`), cell.code));
  return cells;
}

async function scanRule(file: string, family: string, directory: string, temporary: string) {
  const original = readFileSync(join(rulesDir, file), 'utf8');
  const rule = parse(original);
  expect(renderRule(family, rule), `${file}: regenerate semantic helpers`).toBe(original);
  // --rule does not load utilDirs. Inline only the capture-free global syntax classifiers.
  rule.utils = { ...rule.utils, ...globals };
  delete rule.files;
  delete rule.ignores;
  const standalone = join(temporary, file);
  writeFileSync(standalone, stringify(rule, { aliasDuplicateObjects: false }));
  const result = await runAstGrep(['scan', '--rule', standalone, '--json=compact', '--threads', '2', directory]);
  expect([0, 1], result.stderr).toContain(result.code);
  const matches = JSON.parse(result.stdout) as Array<{ file: string; ruleId: string }>;
  for (const match of matches) expect(match.ruleId).toBe(rule.id);
  return new Set(matches.map(match => Number(basename(match.file, '.ts'))));
}

// bound: eleven batched binary scans prove every generated cell; 120 s is the existing rule-test hang guard.
it('refuses the full generated launch-read matrix and lists every documented limit cell', { timeout: 120_000 }, async () => {
  expect(documentedLimits).toHaveLength(EXPECTED_LIMIT_CELLS);
  expect(generate(true), 'regenerate shared semantic helpers').toBe(true);
  const temporary = mkdtempSync(join(tmpdir(), 'cez-launch-matrix-'));
  try {
    for (const family of Object.keys(generated)) {
      const directory = join(temporary, family);
      const cells = writeCells(directory, family);
      const found = new Set<number>();
      for (const file of ruleNames(family)) {
        const matched = await scanRule(file, family, directory, temporary);
        expect(matched.size, `${file}: no invalid cell exercises this rule`).toBeGreaterThan(0);
        for (const index of matched) {
          expect(cells[index]?.kind, `${file}: ${cells[index]?.code}`).toBe('invalid');
          found.add(index);
        }
      }
      for (const [index, cell] of cells.entries()) {
        expect(found.has(index), `${family}/${cell.kind}: ${cell.code}`).toBe(cell.kind === 'invalid');
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
