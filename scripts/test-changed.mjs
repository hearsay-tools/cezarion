#!/usr/bin/env node
// Iteration feedback only: never substitutes for the final validation gate.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const options = { plan: false, base: undefined };
for (const arg of process.argv.slice(2)) {
  if (arg === '--plan') options.plan = true;
  else if (arg.startsWith('--base=') && arg.length > 7) options.base = arg.slice(7);
  else {
    console.error(`Unknown argument: ${arg}. Use --base=<ref> or --plan.`);
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
    const docs = file => /^[^/]+\.md$/.test(file)
      || /^(?:docs|\.ai\/(?:specs|analysis))\/.*\.md$/.test(file);
    const inputs = files.filter(file => !docs(file));
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

const selection = select();
if (options.plan) console.log(JSON.stringify(selection, null, 2));
else {
  console.log(`[test:changed] ${selection.mode}: ${selection.reason}`);
  console.log('[test:changed] Iteration feedback only; the final validation gate is unchanged.');
  if (selection.mode !== 'skip') {
    if (selection.mode === 'changed') console.log('[test:changed] If no tests match, run npm test; do not treat that as a pass.');
    const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', selection.args, {
      cwd: selection.cwd, stdio: 'inherit', shell: process.platform === 'win32',
    });
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status ?? 1;
  }
}
