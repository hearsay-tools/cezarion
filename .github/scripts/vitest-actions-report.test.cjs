const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..', '..');
const vitestConfigPath = path.join(repoRoot, 'vitest.config.ts');

test('root vitest config pins a single github-actions reporter on Actions', () => {
  const source = fs.readFileSync(vitestConfigPath, 'utf8');

  assert.match(
    source,
    /reporters\s*:/,
    'reporters must be explicit — the Vitest default auto-appends github-actions on Actions',
  );
  assert.match(
    source,
    /github-actions/,
    'Actions still gets the job-summary reporter, once, from the root multi-project run',
  );
});

test('a multi-project Actions run writes exactly one Vitest Test Report summary', () => {
  // Keep the probe inside the repo so `vitest/config` resolves from the workspace
  // install. os.tmpdir() can sit outside the monorepo (and under CEZ_TMP), which
  // makes the config loader miss the package.
  const probe = fs.mkdtempSync(path.join(repoRoot, '.tmp-vitest-ga-'));
  const summary = path.join(probe, 'summary.md');
  fs.writeFileSync(summary, '');

  try {
    fs.mkdirSync(path.join(probe, 'a'));
    fs.mkdirSync(path.join(probe, 'b'));
    fs.writeFileSync(
      path.join(probe, 'vitest.config.ts'),
      // Mirrors the root contract: projects + pinned default + one github-actions reporter.
      [
        "import { defineConfig } from 'vitest/config'",
        'export default defineConfig({',
        '  test: {',
        "    reporters: ['default', ['github-actions', { jobSummary: { title: 'Vitest Test Report' } }]],",
        "    projects: ['./a/vitest.config.ts', './b/vitest.config.ts'],",
        '  },',
        '})',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(probe, 'a/vitest.config.ts'),
      "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { name: 'a', include: ['**/*.test.ts'] } })\n",
    );
    fs.writeFileSync(
      path.join(probe, 'b/vitest.config.ts'),
      "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { name: 'b', include: ['**/*.test.ts'] } })\n",
    );
    fs.writeFileSync(
      path.join(probe, 'a/one.test.ts'),
      "import { test, expect } from 'vitest'\ntest('a ok', () => expect(1).toBe(1))\n",
    );
    fs.writeFileSync(
      path.join(probe, 'b/one.test.ts'),
      "import { test, expect } from 'vitest'\ntest('b ok', () => expect(1).toBe(1))\n",
    );

    const vitestBin = path.join(repoRoot, 'node_modules', '.bin', 'vitest');
    const result = spawnSync(vitestBin, ['run', '--config', path.join(probe, 'vitest.config.ts')], {
      cwd: probe,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_ACTIONS: 'true',
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_REPOSITORY: 'wjarka/cezar',
        GITHUB_SHA: 'testsha',
        GITHUB_WORKSPACE: probe,
      },
    });

    assert.equal(result.status, 0, `vitest failed:\n${result.stdout}\n${result.stderr}`);
    const body = fs.readFileSync(summary, 'utf8');
    const headers = body.match(/^## .*$/gm) ?? [];
    assert.equal(
      headers.length,
      1,
      `expected one summary header, got ${headers.length}:\n${body}`,
    );
    assert.match(body, /^## Vitest Test Report$/m);
    assert.match(body, /\*\*2 passes\*\*/);
    assert.doesNotMatch(body, /failure|failures/);
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
});
