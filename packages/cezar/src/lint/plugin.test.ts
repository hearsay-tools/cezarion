import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { oxlintProblems, staleEntries } from './run.ts';
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

const config = JSON.parse(readFileSync(join(repoRoot, '.oxlintrc.json'), 'utf8')) as { jsPlugins: string[]; rules: Record<string, string> };
const plugin = join(repoRoot, 'packages/cezar/src/lint/plugin.ts');

function tree(files: Record<string, string>, oxlintrc: object = { ...config, jsPlugins: [plugin] }): string {
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
  'contract-root-import': ['packages/cezar/src/a.ts', "import { runRecordSchema } from '@open-mercato/cezar-contract';\n"],
  'native-mock-source': ['packages/cezar/test/b.test.ts', "const text = readFileSync(adapter.mockBin, 'utf8');\n"],
  'raw-query-setter': ['packages/web/src/c.tsx', "import { useSearchParams } from 'react-router';\nconst [p, setP] = useSearchParams();\n"],
  'run-fact-reader': ['packages/web/src/lib/d.ts', "const held = attention.label === 'usage limit';\n"],
  'undocumented-env-name': ['packages/cezar/scripts/e.mjs', 'const flag = process.env.CEZ_NOT_DOCUMENTED_ANYWHERE;\n'],
};

/** Each approved exception, by the rule it exercises. None may produce a finding. */
const APPROVED: Record<string, string> = {
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

  it('turn every rule of the plugin on in .oxlintrc.json, and nothing else', () => {
    expect(Object.keys(config.rules).sort()).toEqual(RULES.map((rule) => `cez/${rule.name}`).sort());
    expect(Object.values(config.rules)).toEqual(RULES.map(() => 'error'));
  });

  it.each(Object.entries(VIOLATIONS))('%s reports its seeded violation with file, line and rule', (rule, [file]) => {
    expect(problems.filter((p) => p.startsWith(`${file}:`))).toEqual([expect.stringMatching(new RegExp(`^${file.replaceAll('.', '\\.')}:\\d+:\\d+ cez\\(${rule}\\): .+(?:hearsay-tools/cezarion#|AGENTS\\.md)`))]);
  });

  it('passes every approved exception', () => {
    expect(problems.filter((p) => Object.keys(APPROVED).some((file) => p.startsWith(`${file}:`)))).toEqual([]);
  });

  it('fails a file oxlint cannot parse', () => {
    expect(problems).toContainEqual(expect.stringMatching(/^packages\/cezar\/src\/broken\.ts:1:\d+ oxlint: /));
  });

  it('reports nothing else', () => {
    expect(problems).toHaveLength(Object.keys(VIOLATIONS).length + 1);
  });
});

describe('lint fails closed', () => {
  it('when the plugin does not load', { timeout: OXLINT_TIMEOUT_MS }, async () => {
    const root = seeded({ 'packages/cezar/src/a.ts': 'export const a = 1;\n' }, { ...config, jsPlugins: ['./missing-plugin.ts'] });
    expect(await oxlintProblems(root, ['packages'])).toEqual([expect.stringMatching(/^oxlint failed \(exit \d+\): /)]);
  });

  it('when the config leaves a cez rule off', { timeout: OXLINT_TIMEOUT_MS }, async () => {
    const rules = { ...config.rules, 'cez/run-fact-reader': 'off' };
    const root = seeded({ 'packages/cezar/src/a.ts': 'export const a = 1;\n' }, { ...config, jsPlugins: [plugin], rules });
    expect(await oxlintProblems(root, ['packages'])).toEqual([`oxlint ran ${RULES.length - 1} rules, but the cez plugin defines ${RULES.length}: enable exactly the cez rules in .oxlintrc.json`]);
  });
});

describe('stale entries', () => {
  const lists = {
    'packages/cezar/src/lint/contract-root-import.baseline.json': JSON.stringify({ files: { 'packages/api-client/src/index.ts': 'barrel', 'packages/web/src/gone.ts': 'gone' } }),
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
    ]);
  });

  it('pass the repository as it is', () => {
    expect(staleEntries()).toEqual([]);
  });
});
