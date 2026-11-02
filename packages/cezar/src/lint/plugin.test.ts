import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { oxlintBin, oxlintProblems, staleEntries } from './run.ts';
import { DESIGN_SAMPLES } from './design-guardian.testkit.ts';
import { RULES } from './plugin.ts';
import { repoRoot } from './source-rule.ts';

/**
 * The `cez` rules as `npm run lint` runs them: the real oxlint binary and the real
 * `.oxlintrc.json`, over seeded files in a temporary tree laid out like the repository
 * (hearsay-tools/cezarion#2416). Each rule must report its seeded violation and pass its approved
 * exception, and every tool failure must fail lint.
 */
// bound: each case starts oxlint once, about a second on an idle host; this is a hang guard for a
// loaded host, and the runner's own 300 s process timeout stays the outer limit.
const OXLINT_TIMEOUT_MS = 120_000;

const config = JSON.parse(readFileSync(join(repoRoot, '.oxlintrc.json'), 'utf8')) as { jsPlugins: string[]; plugins: string[]; rules: Record<string, string | [string, object]> };
const plugin = join(repoRoot, 'packages/cezar/src/lint/plugin.ts');
// Scanner fixtures test cez exceptions independently of built-in policy.
const cezOnly = { ...config, plugins: [], overrides: [], rules: Object.fromEntries(Object.entries(config.rules).filter(([rule]) => rule.startsWith('cez/'))), jsPlugins: [plugin] };

function tree(files: Record<string, string>, oxlintrc: object = cezOnly): string {
  const root = mkdtempSync(join(tmpdir(), 'cez-lint-'));
  writeFileSync(join(root, '.oxlintrc.json'), JSON.stringify(oxlintrc));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const roots: string[] = [];
const seeded = (files: Record<string, string>, oxlintrc?: object) => {
  const root = tree(files, oxlintrc);
  roots.push(root);
  return root;
};
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const VIOLATIONS: Record<string, [string, string]> = {
  'unit-wait-discipline': ['packages/web/src/wait-violation.test.tsx', 'await sleep(5);\n'],
  'test-wait-discipline': ['packages/cezar/src/wait-violation.test.ts', 'await sleep(5);\n'],
  'card-2-contrast': ['packages/web/src/unsafe.tsx', '<p className="bg-card-2 text-danger text-xs">bad</p>'],
  'design-guardian': ['packages/web/src/design-violation.tsx', 'const value = "h-screen";\n'],
  'contract-root-import': ['packages/cezar/src/a.ts', "import { runRecordSchema } from '@open-mercato/cezar-contract';\n"],
  'native-mock-source': ['packages/cezar/test/b.test.ts', "const text = readFileSync(adapter.mockBin, 'utf8');\n"],
  'raw-query-setter': ['packages/web/src/c.tsx', "import { useSearchParams } from 'react-router';\nconst [p, setP] = useSearchParams();\n"],
  'run-fact-reader': ['packages/web/src/lib/d.ts', "const held = attention.label === 'usage limit';\n"],
  'run-history-reader': ['packages/cezar/src/raw-history.ts', 'const text = readFileSync(historyPaths(dir, id).plain);\n'],
  'undocumented-env-name': ['packages/cezar/scripts/e.mjs', 'const flag = process.env.CEZ_NOT_DOCUMENTED_ANYWHERE;\n'],
};

/** Each approved exception, by the rule it exercises. None may produce a finding. */
const APPROVED: Record<string, string> = {
  'packages/web/src/wait-approved.test.tsx': 'await sleep(5); // bound: a negative window\n',
  'packages/cezar/src/wait-approved.test.ts': 'await sleep(5); // bound: a negative window\n',
  'packages/web/src/routes/unknown-project.tsx': '<div className="bg-card-2"><span className="font-mono text-[11px] font-normal text-soft-foreground">old</span></div>',

  'packages/web/src/styles/index.ts': 'export const value = "h-dvh";',
  'packages/web/src/lib/bookmarklet.ts': 'alert("hello");',
  'packages/web/src/design-guardian.test.ts': 'confirm();',
  // contract-root-import: the listed barrel, and type imports anywhere.
  'packages/api-client/src/index.ts': "export * from '@open-mercato/cezar-contract';\n",
  'packages/web/src/f.ts': "import type { RunRecord } from '@open-mercato/cezar-contract';\ntype T = import('@open-mercato/cezar-api-client').X;\n",
  // native-mock-source: pointing the runner at the real mock.
  'packages/cezar/test/g.test.ts': 'process.env[adapter.binEnv] = adapter.mockBin;\n',
  // raw-query-setter: the baseline's reasoned exception, and a read-only tuple.
  'packages/web/src/routes/task-git/task-files.tsx': "import { useSearchParams } from 'react-router';\nconst [query, setQuery] = useSearchParams();\n",
  'packages/web/src/h.tsx': "import { useSearchParams } from 'react-router';\nconst [query] = useSearchParams();\n",
  // run-fact-reader: a listed reader, and a test spelling the hold as its oracle.
  'packages/web/src/lib/tasks-table.ts': 'const at = run.autoResumeAt;\n',
  'packages/cezar/src/i.test.ts': "until(() => run.status === 'waiting' && run.autoResumeAt !== undefined);\n",
  'packages/cezar/src/fixed-history-name.ts': 'readFileSync("prefix".concat("run.ndjson"));\n',
  'packages/cezar/src/runs/history-stream.ts': 'const paths = historyPaths(dir, id);\n',
  // undocumented-env-name: a documented name, a mock control, and a test.
  'packages/cezar/src/j.ts': "const a = process.env.CEZ_DRY_RUN; const b = env.CEZ_MOCK_ANYTHING;\n",
  'packages/cezar/src/k.test.ts': 'const c = process.env.CEZ_NOT_DOCUMENTED_ANYWHERE;\n',
};

describe('the cez rules under oxlint', () => {
  let problems: string[] = [];
  beforeAll(async () => {
    const files = { ...Object.fromEntries(Object.values(VIOLATIONS)), ...APPROVED, 'packages/cezar/src/broken.ts': 'let x = ;\n' };
    problems = await oxlintProblems(seeded(files), ['packages']);
  }, OXLINT_TIMEOUT_MS);

  it('selects the lint bridge when the contrast palette stylesheet changes', () => {
    const squeal = JSON.parse(readFileSync(join(repoRoot, 'squeal.config.json'), 'utf8')) as { inputs: Record<string, string[]> };
    expect(squeal.inputs['packages/cezar/src/lint/lint-runner.test.ts']).toContain('packages/web/src/styles/index.css');
  });

  it('turns every cez rule on, and every other entry is a known built-in', () => {
    const cez = Object.entries(config.rules).filter(([rule]) => rule.startsWith('cez/'));
    expect(cez.map(([rule]) => rule).sort()).toEqual(RULES.map((rule) => `cez/${rule.name}`).sort());
    expect(cez.map(([, severity]) => severity)).toEqual(RULES.map(() => 'error'));
    const catalog = JSON.parse(execFileSync(process.execPath, [oxlintBin(), '--rules', '-f', 'json'], { encoding: 'utf8' })) as Array<{ scope: string; value: string }>;
    const known = new Set(catalog.map(({ scope, value }) => scope === 'eslint' ? value : `${scope}/${value}`));
    for (const rule of Object.keys(config.rules).filter((name) => !name.startsWith('cez/'))) expect(known.has(rule)).toBe(true);
  });

  it.each(Object.entries(VIOLATIONS))('%s reports its seeded violation with file, line and rule', (rule, [file]) => {
    expect(problems.filter((p) => p.startsWith(`${file}:`))).toEqual([expect.stringMatching(new RegExp(`^${file.replaceAll('.', '\\.')}:\\d+:\\d+ cez\\(${rule}\\): .+(?:hearsay-tools/cezarion#|AGENTS\\.md)`))]);
  });

  it('passes every approved exception', () => {
    expect(problems.filter((p) => Object.keys(APPROVED).some((file) => p.startsWith(`${file}:`)))).toEqual([]);
  });

  it.each([
    'readFileSync(this.eventsPath(id))',
    'readFileSync(`${id}.ndjson`)',
    'readFileSync(id + ".ndjson.br")',
    'readFileSync(id\n + ".ndjson")',
    'readFileSync(id + (".ndjson"))',
    'readFileSync(`${id}.ndjson` /* explanation */ + ".br")',
    'readFileSync(`${id}.ndjson${compressed ? ".br" : ""}`)',
    'readFileSync(`${id}${".ndjson"}`)',
    'readFileSync(prefix.concat(runId, ".ndjson"))',
    'readFileSync(`${id}` + ".ndjson")',
    'import { historyPaths as pathsForRun } from "./runs/history-file.ts"; readFileSync(pathsForRun(dir, id).plain);',
  ])('refuses direct transcript access under oxlint: %s', async (source) => {
    const file = 'packages/cezar/src/raw.ts';
    const result = await oxlintProblems(seeded({ [file]: source }), ['packages']);
    expect(result).toEqual([expect.stringContaining('cez(run-history-reader)')]);
  }, OXLINT_TIMEOUT_MS);

  it('fails a file oxlint cannot parse', () => {
    expect(problems).toContainEqual(expect.stringMatching(/^packages\/cezar\/src\/broken\.ts:1:\d+ oxlint: /));
  });

  it('reports nothing else', () => {
    expect(problems).toHaveLength(Object.keys(VIOLATIONS).length + 1);
  });
});

describe('lint fails closed', () => {
  it('when the plugin does not load', { timeout: OXLINT_TIMEOUT_MS }, async () => {
    const root = seeded({ 'packages/cezar/src/a.ts': 'export const a = 1;\n' }, { ...cezOnly, jsPlugins: ['./missing-plugin.ts'] });
    expect(await oxlintProblems(root, ['packages'])).toEqual([expect.stringMatching(/^oxlint failed \(exit \d+\): /)]);
  });

  it('when the config leaves a cez rule off', { timeout: OXLINT_TIMEOUT_MS }, async () => {
    const rules = { ...cezOnly.rules, 'cez/run-fact-reader': 'off' };
    const root = seeded({ 'packages/cezar/src/a.ts': 'export const a = 1;\n' }, { ...cezOnly, rules });
    expect(await oxlintProblems(root, ['packages'])).toEqual([`oxlint ran ${RULES.length - 1} rules, but .oxlintrc.json turns on ${RULES.length} (${RULES.length} cez + 0 built-in)`]);
  });

  it('runs an explicitly listed built-in rule', { timeout: OXLINT_TIMEOUT_MS }, async () => {
    const root = seeded({ 'packages/cezar/src/a.ts': 'debugger;\n' }, { ...cezOnly, rules: { ...cezOnly.rules, 'no-debugger': 'error' } });
    expect(await oxlintProblems(root, ['packages'])).toEqual([expect.stringContaining('eslint(no-debugger)')]);
  });

  it('when a built-in plugin is missing', { timeout: OXLINT_TIMEOUT_MS }, async () => {
    const root = seeded({ 'packages/cezar/src/a.ts': 'export const a = 1;\n' }, { ...cezOnly, rules: { ...cezOnly.rules, 'unicorn/no-new-array': 'error' } });
    expect(await oxlintProblems(root, ['packages'])).toEqual([
      '.oxlintrc.json: built-in rule unicorn/no-new-array requires plugin unicorn in plugins',
      `oxlint ran ${RULES.length} rules, but .oxlintrc.json turns on ${RULES.length + 1} (${RULES.length} cez + 1 built-in)`,
    ]);
  });

  it('when a category can add implicit rules', { timeout: OXLINT_TIMEOUT_MS }, async () => {
    const root = seeded({ 'packages/cezar/src/a.ts': 'export const a = 1;\n' }, { ...cezOnly, categories: { correctness: 'error' } });
    expect(await oxlintProblems(root, ['packages'])).toContain('.oxlintrc.json: category correctness must be off; list built-in rules explicitly');
  });

});

describe('stale entries', () => {
  const lists = {
    'packages/web/src/test/card-2-contrast.baseline.json': JSON.stringify(['gone.tsx: <p className="bg-card-2 text-danger">']),
    'packages/cezar/src/lint/contract-root-import.baseline.json': JSON.stringify({ files: { 'packages/api-client/src/index.ts': 'barrel', 'packages/web/src/gone.ts': 'gone' } }),
    'packages/cezar/src/lint/run-history-readers.json': JSON.stringify({ entries: [] }),
    'packages/cezar/src/lint/resume-time-readers.json': JSON.stringify({ files: { 'packages/web/src/lib/reads.ts': 'reads', 'packages/web/src/lib/stopped.ts': 'stopped' } }),
    'packages/web/src/test/search-params-discipline.baseline.json': JSON.stringify({ sites: [{ file: 'routes/x.tsx', site: '[query, setQuery] = useSearchParams()', reason: 'r' }] }),
    'packages/api-client/src/index.ts': "export * from '@open-mercato/cezar-contract';\n",
    'packages/web/src/lib/reads.ts': 'const at = run.autoResumeAt;\n',
    'packages/web/src/lib/stopped.ts': 'const at = run.startedAt;\n',
    'packages/web/src/routes/x.tsx': "import { useSearchParams } from 'react-router';\nconst [query] = useSearchParams();\n",
  };

  it('name every exemption, reader and baseline entry that no longer matches', () => {
    expect(staleEntries(seeded(lists))).toEqual([
      'packages/cezar/src/lint/contract-root-import.baseline.json cez/contract-root-import: packages/web/src/gone.ts no longer imports a contract root at runtime; remove its exemption',
      'packages/cezar/src/lint/resume-time-readers.json cez/run-fact-reader: packages/web/src/lib/stopped.ts no longer reads autoResumeAt; remove it from the list',
      'packages/web/src/test/search-params-discipline.baseline.json cez/raw-query-setter: routes/x.tsx no longer has [query, setQuery] = useSearchParams(); remove the entry',
      'packages/web/src/test/card-2-contrast.baseline.json cez/card-2-contrast: stale entry gone.tsx: <p className="bg-card-2 text-danger">. Fix new sites; remove fixed entries from the baseline. Never add allowances. (hearsay-tools/cezarion#1133, hearsay-tools/cezarion#2423).',
    ]);
  });

  it('pass the repository as it is', () => {
    expect(staleEntries()).toEqual([]);
  });
});

// Each original guardian rule runs through the real oxlint adapter, including e2e scope.
it.each(Object.entries(DESIGN_SAMPLES))('oxlint runs guardian %s', async (name, token) => {
  const file = name === 'fixture-serve-must-pin-cez-home' ? 'packages/web/e2e/design.e2e.ts' : 'packages/web/src/design.tsx';
  const result = await oxlintProblems(seeded({ [file]: `// first line\nconst token = "${token}";` }), ['packages']);
  expect(result).toEqual([expect.stringContaining(`${file}:2:`)]);
  expect(result[0]).toContain(`${name} —`);
}, OXLINT_TIMEOUT_MS);
