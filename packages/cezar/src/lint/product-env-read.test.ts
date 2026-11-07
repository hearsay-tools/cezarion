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
    function f({ CEZ_B, HSQ_C: c }: NodeJS.ProcessEnv) { return c; }
    function g({ CEZ_D }: NodeJS.ProcessEnv = process.env) {}
    function h({ HSQ_E } = process.env) {}
    function typed({ CEZ_F }: NodeJS.ProcessEnv = {}) {}`);
  expect(reads.map(({form, name}) => [form, name])).toEqual(['CEZ_X', 'HSQ_Y', 'CEZ_Z', 'CEZ_A', 'CEZ_B', 'HSQ_C', 'CEZ_D', 'HSQ_E', 'CEZ_F'].map(name => ['destructure', name]));
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

it('scans nested env patterns from process and globalThis with renames, defaults and rest', () => {
  const source = `const {env: {CEZ_NESTED}} = process;
    const {env: {HSQ_RENAMED: local = 'x'} = {}} = globalThis.process;
    ({process: {env: {['CEZ_ASSIGNED']: value} = {}}} = globalThis);
    function f({env: {HSQ_PARAMETER} = {}} = process) {}
    const {env: selected = {}} = globalThis.process; const {CEZ_ALIAS} = selected;
    const {env: {CEZ_PICKED, ...remaining}} = process; const {HSQ_REST} = remaining;
    const {...processCopy} = process; const {env: {CEZ_PROCESS_REST}} = processCopy;
    const {process: renamedProcess = process} = globalThis;
    const {env: {HSQ_PROCESS_ALIAS}} = renamedProcess;`;
  expect(productEnvReads(source).map(({form, name}) => [form, name])).toEqual([
    ['destructure', 'CEZ_NESTED'], ['destructure', 'HSQ_RENAMED'],
    ['destructure', 'CEZ_ASSIGNED'], ['destructure', 'HSQ_PARAMETER'],
    ['destructure', 'CEZ_ALIAS'], ['destructure', 'CEZ_PICKED'], ['computed', '*'],
    ['destructure', 'HSQ_REST'], ['destructure', 'CEZ_PROCESS_REST'],
    ['destructure', 'HSQ_PROCESS_ALIAS'],
  ]);
  expect(scanProductEnvReads('packages/cezar/src/new-reader.ts', source, [])).toHaveLength(10);
});

it('scans computed nested pattern keys and default env sources without flagging ordinary patterns', () => {
  const source = `const {env: {[key]: selected, [\`HSQ_STATIC\`]: renamed}} = process;
    const {other: {CEZ_DEFAULT} = process.env} = input;
    const {env: {...rest}} = globalThis.process; const {CEZ_REST} = rest;
    const {config: {CEZ_FIXTURE}} = fixture; const {ordinary} = process.env;`;
  expect(productEnvReads(source).map(({form, name}) => [form, name])).toEqual([
    ['computed', '*'], ['destructure', 'HSQ_STATIC'], ['destructure', 'CEZ_DEFAULT'],
    ['computed', '*'], ['destructure', 'CEZ_REST'],
  ]);
});

it('accepts commented and static template helper suffixes but rejects all dynamic suffixes', () => {
  const source = `import {productEnv /* import comment */ as setting} from './product-env.ts';
    setting(/* reason */ \`NEW_FLAG\`); productEnv?.(/* reason */ 'OTHER_FLAG');
    productEnv(\`FLAG_\${name}\`); setting(suffix); productEnv(); productEnv(...suffixes);`;
  expect(productEnvReads(source).map(read => read.form)).toEqual(Array(4).fill('helper-dynamic'));
});


it('tracks nested typed parameters and env bindings with an unknown outer source', () => {
  const source = `function typed({env: {CEZ_TYPED}}: NodeJS.Process) {}
    function queried({env: {HSQ_QUERIED}}: typeof process) {}
    function untyped({env: {CEZ_UNTYPED}}) {}
    const {env: settings} = input; const {HSQ_SELECTED} = settings;
    const {process: {env: {CEZ_GLOBAL}}} = globalThis;
    const {[unknown]: candidate} = process;
    for (const {env: {HSQ_LOOP}} of inputs) {}
    for ({env: {CEZ_LOOP_ASSIGN}} of inputs) {}`;
  expect(productEnvReads(source).map(({form, name}) => [form, name])).toEqual([
    ['destructure', 'CEZ_TYPED'], ['destructure', 'HSQ_QUERIED'],
    ['destructure', 'CEZ_UNTYPED'], ['destructure', 'HSQ_SELECTED'],
    ['destructure', 'CEZ_GLOBAL'], ['computed', '*'], ['destructure', 'HSQ_LOOP'],
    ['destructure', 'CEZ_LOOP_ASSIGN'],
  ]);
});
