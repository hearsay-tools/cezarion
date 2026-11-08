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


it.each([
  'ProcessEnv', 'NodeJS.ProcessEnv', 'Runtime.NodeJS.ProcessEnv',
  'typeof process.env', 'typeof globalThis.process.env',
  "typeof process['env']", "typeof globalThis.process['env']",
  'Partial<NodeJS.ProcessEnv>', 'Readonly<ProcessEnv>', 'Required<ProcessEnv>',
  "Pick<ProcessEnv, 'CEZ_DRY_RUN'>", 'Partial<Readonly<Required<ProcessEnv>>>',
  'ProcessEnv | undefined', 'undefined | (ProcessEnv & {extra: string})',
  '(ProcessEnv)', 'Omit<ProcessEnv, "PATH">', 'NonNullable<ProcessEnv | undefined>',
])('classifies env object annotations consistently: %s', annotation => {
  const source = `function destructured({CEZ_DRY_RUN}: ${annotation}) {}
    function named(settings: ${annotation}) { return settings[key]; }
    const selected: ${annotation} = supplied; const {HSQ_FLAG} = selected;
    const {CEZ_DECLARED}: ${annotation} = supplied;`;
  expect(productEnvReads(source).map(({form, name}) => [form, name])).toEqual([
    ['destructure', 'CEZ_DRY_RUN'], ['computed', '*'],
    ['destructure', 'HSQ_FLAG'], ['destructure', 'CEZ_DECLARED'],
  ]);
});

it('resolves local aliases, generic substitutions, defaults, forward references and recursive unions', () => {
  const source = `type Wrapped<T> = Readonly<Partial<T>>;
    type Env = Later; type Later = Wrapped<typeof globalThis.process.env>;
    type Chained<T> = Wrapped<T>; type Defaulted<T = NodeJS.ProcessEnv> = Required<T>;
    type Recursive = Recursive | ProcessEnv;
    function f({CEZ_ALIAS}: Env) {}
    function g({HSQ_GENERIC}: Chained<ProcessEnv>) {}
    function h({CEZ_DEFAULTED}: Defaulted) {}
    function r({HSQ_RECURSIVE}: Recursive) {}
    const settings: Env = supplied; const {CEZ_VARIABLE} = settings;
    const {HSQ_DECLARED}: Wrapped<Env> = supplied;`;
  expect(productEnvReads(source).map(read => read.name)).toEqual([
    'CEZ_ALIAS', 'HSQ_GENERIC', 'CEZ_DEFAULTED', 'HSQ_RECURSIVE', 'CEZ_VARIABLE', 'HSQ_DECLARED',
  ]);
});

it('does not classify arrays, tuples, keys, scalar indexed types or unrelated aliases as env objects', () => {
  const source = `type Cycle = Cycle; type List<T> = T[];
    type EnvList = ReadonlyArray<ProcessEnv>; type Ordinary = {other: string};
    function a({CEZ_ARRAY}: ProcessEnv[]) {}
    function b({CEZ_GENERIC_ARRAY}: Array<ProcessEnv>) {}
    function c({CEZ_READONLY_ARRAY}: EnvList) {}
    function d({CEZ_WRAPPED_ARRAY}: Partial<List<ProcessEnv>>) {}
    function e({CEZ_UNION_ARRAY}: ProcessEnv[] | undefined) {}
    function f({CEZ_TUPLE}: [ProcessEnv]) {}
    function g({CEZ_KEYS}: keyof ProcessEnv) {}
    function h({CEZ_SCALAR}: (typeof process.env)['PATH']) {}
    function i({CEZ_CYCLE}: Cycle) {}
    function j({CEZ_ORDINARY}: Ordinary) {}
    function named(collection: Array<ProcessEnv>) { return collection[key]; }`;
  expect(productEnvReads(source)).toEqual([]);
});

it('keeps permanent non-setting exemptions exact and rejects product settings in each file', async () => {
  const { nonSettingEnvReads, nonSettingEnvRead } = await import('./product-env-read.ts');
  for (const entry of nonSettingEnvReads) {
    expect(entry.reason.length).toBeGreaterThan(10);
    expect(scanProductEnvReads(entry.file, `${entry.expression};`, [])).toEqual([]);
    expect(scanProductEnvReads(entry.file, 'process.env[other];', [])).toHaveLength(1);
    for (const source of ['env.CEZ_DRY_RUN;', "env['HSQ_DRY_RUN'];", 'const {CEZ_DRY_RUN} = env;', 'productEnv(suffix);']) {
      expect(scanProductEnvReads(entry.file, source, [])).toHaveLength(1);
    }
    if (entry.expression.endsWith('[name]')) expect(scanProductEnvReads(entry.file, `const name = 'CEZ_DRY_RUN'; const source = process.env; ${entry.expression};`, [])).toHaveLength(1);
    expect(nonSettingEnvRead(entry.file, {form: 'dot', name: 'CEZ_DRY_RUN', offset: 0, expression: entry.expression})).toBe(false);
  }
});

it('exempts only fixture control names in mock scripts, not product settings or other paths', () => {
  const mock = 'packages/cezar/scripts/mock-native.mjs';
  expect(scanProductEnvReads(mock, "process.env.CEZ_MOCK_CONTROL; env['CEZ_MOCK_CONTROL'];", [])).toEqual([]);
  for (const file of [mock, 'packages/cezar/scripts/probe.mjs', 'packages/cezar/src/mock-native.ts']) {
    expect(scanProductEnvReads(file, 'process.env.CEZ_DRY_RUN; env.HSQ_DRY_RUN;', [])).toHaveLength(2);
  }
  expect(scanProductEnvReads('packages/cezar/src/mock-native.ts', 'env.CEZ_MOCK_CONTROL;', [])).toHaveLength(1);
  expect(scanProductEnvReads(mock, 'process.env.HSQ_MOCK_CONTROL;', [])).toHaveLength(1);
});

it.each(['config.key', "config['PATH']", 'config?.key', 'getKey()', '42', 'true', '`prefix_${key}`'])(
  'keeps nonliteral key initializers visible: %s', initializer => {
    expect(productEnvReads(`const name = ${initializer}; process.env[name];`).map(({form, name}) => [form, name]))
      .toEqual([['computed', '*']]);
  },
);

it('resolves only immutable literal key aliases and keeps mutable or cyclic keys unknown', () => {
  expect(productEnvReads("const root = 'CEZ_DRY_RUN'; const name = root; env[name];").map(({form, name}) => [form, name]))
    .toEqual([['bracket', 'CEZ_DRY_RUN']]);
  expect(productEnvReads('const root = `HSQ_DRY_RUN`; const next = root; const name = next; env[name];').map(read => read.name))
    .toEqual(['HSQ_DRY_RUN']);
  expect(productEnvReads("let name = 'PATH'; name = config.key; env[name];").map(read => read.form)).toEqual(['computed']);
  expect(productEnvReads('const name = next; const next = name; env[name];').map(read => read.form)).toEqual(['computed']);
});

it('keeps shadowed literal names unknown in computed reads', () => {
  for (const source of [
    "const key = 'PATH'; function f(key) { return process.env[key]; }",
    "const key = 'PATH'; function f() { const key = config.key; return process.env[key]; }",
    "const key = 'PATH'; try {} catch (key) { process.env[key]; }",
  ]) expect(productEnvReads(source).map(({form, name}) => [form, name])).toEqual([['computed', '*']]);
});
