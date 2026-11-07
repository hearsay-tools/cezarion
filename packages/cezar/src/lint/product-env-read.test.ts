import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { productEnvBaselineFile, productEnvFile, productEnvReads, scanProductEnvReads, staleProductEnvReads } from './product-env-read.ts';

it('inventories dot, bracket, optional, env-argument, alias and computed reads', () => {
  const source = `process.env.CEZ_X; process['env']['HSQ_X']; env?.CEZ_Y;
    function f(source: NodeJS.ProcessEnv) { return source[key]; }
    const selected = process.env; selected.HSQ_Y; process.env[name];
    const {env: inherited} = process; inherited['CEZ_Z'];`;
  expect(productEnvReads(source).map(({form, name}) => [form, name])).toEqual([
    ['dot', 'CEZ_X'], ['bracket', 'HSQ_X'], ['dot', 'CEZ_Y'], ['computed', '*'],
    ['dot', 'HSQ_Y'], ['computed', '*'], ['bracket', 'CEZ_Z'],
  ]);
});

it('supports destructuring declarations and assignments with renames and defaults', () => {
  const reads = productEnvReads(`const {CEZ_X, HSQ_Y: renamed = 'default', ['CEZ_Z']: z} = process.env;
    ({CEZ_A: value} = env); const { ordinary } = process.env;
    function f({ CEZ_B, HSQ_C: c }: NodeJS.ProcessEnv) { return c; }`);
  expect(reads.map(({form, name}) => [form, name])).toEqual(['CEZ_X', 'HSQ_Y', 'CEZ_Z', 'CEZ_A', 'CEZ_B', 'HSQ_C'].map(name => ['destructure', name]));
});

it('permits plain writes, deletes, comments and fixtures, but flags compound updates and computed-key reads', () => {
  const source = `process.env.CEZ_WRITE = 'x'; delete env.HSQ_DELETE; [env.CEZ_TARGET] = ['x'];
    ({x: env.HSQ_TARGET} = data); for (process.env.CEZ_LOOP of names) {} for (env.HSQ_LOOP in names) {} env.CEZ_PLUS += 'x'; env.HSQ_INCREMENT++;
    env[process.env.CEZ_KEY] = 'x'; // process.env.CEZ_COMMENT
    const fixture = { CEZ_FIXTURE: 'value' }; const text = 'env.HSQ_STRING';`;
  expect(productEnvReads(source).map(read => read.name)).toEqual(['CEZ_PLUS', 'HSQ_INCREMENT', 'CEZ_KEY']);
  for (const file of ['packages/cezar/src/x.test.ts', 'packages/cezar/src/x.testkit.ts', 'packages/cezar/src/fixtures/x.ts', 'packages/cezar/src/core/product-env.ts']) {
    expect(scanProductEnvReads(file, source, [])).toEqual([]);
  }
  expect(productEnvFile('packages/cezar/scripts/runner.mjs')).toBe(true);
});

it('requires a literal helper suffix and consumes only matching baseline counts', () => {
  const file = 'packages/cezar/src/reader.ts';
  const source = `import {productEnv as setting} from './product-env.ts'; setting?.(suffix); productEnv('DRY_RUN'); productEnv(suffix); env.CEZ_X; env.CEZ_X; env['CEZ_X'];`;
  expect(scanProductEnvReads(file, source, [{file, form: 'dot', name: 'CEZ_X', reads: 1}]).map(({form, name}) => [form, name]))
    .toEqual([['helper-dynamic', '*'], ['helper-dynamic', '*'], ['dot', 'CEZ_X'], ['bracket', 'CEZ_X']]);
});

it('rejects stale, duplicate and invalid allowances', () => {
  const root = mkdtempSync(join(tmpdir(), 'env-lint-'));
  const file = 'packages/cezar/src/reader.ts';
  const baseline = join(root, productEnvBaselineFile);
  mkdirSync(dirname(baseline), {recursive: true});
  mkdirSync(dirname(join(root, file)), {recursive: true});
  writeFileSync(join(root, file), 'env.CEZ_X;');
  const valid = {file, form: 'dot', name: 'CEZ_X', reads: 1};
  const write = (entries: object[]) => writeFileSync(baseline, JSON.stringify({entries}));
  try {
    write([valid]);
    expect(staleProductEnvReads(root)).toEqual([]);
    write([valid, valid, {...valid, name: 'CEZ_MISSING'}, {...valid, reads: 0}]);
    expect(staleProductEnvReads(root)).toHaveLength(3);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
