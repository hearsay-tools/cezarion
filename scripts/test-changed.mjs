#!/usr/bin/env node
// Iteration feedback only: never substitutes for the final validation gate.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { unitFiles } from './ci-test-selection.mjs';

// CI's docs-only rule: skip exactly the paths that skip CI's Vitest shards.
const { isDocsPath } = createRequire(import.meta.url)('../.github/scripts/change-surface.cjs');

const options = { plan: false, base: undefined, ci: false, forward: [] };
const argv = process.argv.slice(2);
for (const [index, arg] of argv.entries()) {
  if (arg === '--' && options.ci) { options.forward = argv.slice(index + 1); break; }
  if (arg === '--help' || arg === '-h') {
    const output = Promise.withResolvers();
    process.stdout.write(`Usage: npm run test:changed -- [--base=<ref>] [--plan] [--ci [-- <Vitest args>]] [--help | -h]

Selection rules:
  Compare against the merge-base with local origin/main (or main), including
  branch commits and staged, unstaged, and untracked files. No fetch is made.
  --base=<ref> overrides the comparison ref; its merge-base with HEAD is used.
  --plan prints the selection as JSON without running tests.
  --ci resolves test files first; a selector error or no match runs full Vitest.
  With --ci, arguments after -- go to Vitest (including shard and coverage flags).
  Inspect --plan before running tests. If it selects the full suite, choose
  focused checks and leave full verification to CI.

  Ordinary TS/JS source in packages/{cezar,web,api-client}/src selects tests
  through Vitest's import graph. Eligible extensions: ts, tsx, js, jsx, mjs.
  Fixtures, snapshots, test directories, and vite/vitest/setup inputs are excluded.
  Shared inputs (including packages/contract), configuration, unknown inputs,
  unusual source paths, deletions or renames, and missing Git or base information
  fall back to full Vitest.

  Clean changes and changes confined to CI's docs-only list skip iteration tests.
  isDocsPath in .github/scripts/change-surface.cjs is the exact definition.
  Markdown listed in testReadDocuments is never docs-only.
  No matching test is an error; run npm test or select relevant tests explicitly
  and report any coverage gap.

To classify branch commits as CI does, run:
  git diff --name-only --no-renames origin/main...HEAD | jq -R . | node .github/scripts/change-surface.cjs
This prints docs-only, infra-only or full-matrix.

This command provides iteration feedback. Import graphs do not cover every
runtime dependency. CI's gate is final.
`, output.resolve);
    await output.promise;
    process.exit(0);
  }
  else if (arg === '--plan') options.plan = true;
  else if (arg === '--ci') options.ci = true;
  else if (arg.startsWith('--base=') && arg.length > 7) options.base = arg.slice(7);
  else {
    console.error(`Unknown argument: ${arg}. Use --base=<ref>, --plan, or --help.`);
    process.exit(2);
  }
}

function select() {
  let cwd = process.cwd();
  const git = (...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
  });
  const full = (reason, files = []) => ({ mode: 'full', reason, files, args: ['test'] });
  try {
    cwd = git('rev-parse', '--show-toplevel').trim();
    let ref = options.base;
    if (!ref) {
      // No fetch and no network. An absent local base is not permission to skip.
      try { git('rev-parse', '--verify', 'origin/main^{commit}'); ref = 'origin/main'; }
      catch { ref = 'main'; }
    }
    const resolved = git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
    const base = git('merge-base', 'HEAD', resolved).trim();
    const files = [...new Set([
      ...git('diff', '--no-renames', '--name-only', '-z', base, 'HEAD', '--').split('\0'),
      ...git('diff', '--cached', '--no-renames', '--name-only', '-z', 'HEAD', '--').split('\0'),
      ...git('diff', '--no-renames', '--name-only', '-z', '--').split('\0'),
      ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0'),
    ].filter(Boolean))].sort();
    // Removed paths (including the old side of a rename) may no longer appear
    // in Vitest's current import graph. Fall back instead of losing consumers.
    if (files.some(file => !existsSync(join(cwd, file)))) return { ...full('Deleted or renamed input', files), cwd };
    const inputs = files.filter(file => !isDocsPath(file));
    if (!inputs.length) return { mode: 'skip', reason: files.length ? 'Documentation-only changes' : 'No changes', base, files, args: [], cwd };
    // Only ordinary TS/JS source is eligible for import-graph selection.
    // Contract, build inputs, configs, fixtures, scripts and unknown surfaces
    // deliberately run the full suite. Avoid Git's quoted-filename ambiguity.
    const source = file => /^[\x21-\x7e]+$/.test(file)
      && !/["\\]/.test(file)
      && /^packages\/(?:cezar|web|api-client)\/src\/.+\.(?:ts|tsx|js|jsx|mjs)$/.test(file)
      && !/(?:^|\/)(?:__fixtures__|fixtures|__snapshots__|test)(?:\/|$)/.test(file)
      && !/(?:^|\/)(?:vitest|vite|setup)[^/]*\.[cm]?[jt]s$/.test(file);
    if (!inputs.every(source)) return { ...full('Shared, configuration, or unclassified input', files), cwd };
    return {
      mode: 'changed', reason: 'Vitest import-graph selection (iteration only)', base, files, cwd,
      // No matches is not a successful verification: require an explicit full
      // run rather than silently accepting root passWithNoTests=true.
      args: ['test', '--', `--changed=${base}`, '--passWithNoTests=false'],
    };
  } catch {
    return { ...full('Cannot establish complete Git changes or merge-base'), cwd };
  }
}

let selection = select();
if (options.ci) {
  const files = unitFiles(selection);
  selection = files === null
    ? { ...selection, mode: 'full', reason: 'CI full fallback: unsafe, failed or empty selection', args: ['test', '--', ...options.forward] }
    : { ...selection, args: ['test', '--', ...files, ...options.forward, '--passWithNoTests=true'] };
}
if (options.plan) console.log(JSON.stringify(selection, null, 2));
else {
  console.log(`[test:changed] ${selection.mode}: ${selection.reason}`);
  console.log(options.ci ? '[test:changed] PR selection; the merge queue runs the full suite.' : '[test:changed] Iteration feedback only; the final validation gate is unchanged.');
  if (selection.mode !== 'skip') {
    if (selection.mode === 'changed' && !options.ci) console.log('[test:changed] If no tests match, run npm test; do not treat that as a pass.');
    const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', selection.args, {
      cwd: selection.cwd, stdio: 'inherit', shell: process.platform === 'win32',
    });
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status ?? 1;
  }
}
