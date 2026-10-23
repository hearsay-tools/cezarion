#!/usr/bin/env node
// Serve an owned isolated clone, never the live checkout.
// node .ai/scripts/e2e-served-repo.mjs <checkout> <target> prepares the clone.
// --sync <checkout> <target> refreshes fixture content; exit 3 means HEAD moved.
// Replace targets only after removeLane ownership checks.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { cloneIsolatedCheckout, removeLane, syncCurrentEdits } from './e2e-lanes.mjs';

const args = process.argv.slice(2);
const sync = args[0] === '--sync';
const [repoRoot, target] = sync ? args.slice(1) : args;
if (!repoRoot || !target) {
  process.stderr.write('usage: e2e-served-repo.mjs [--sync] <checkout> <target>\n');
  process.exit(2);
}
try {
  if (sync) process.exit(syncCurrentEdits({ repoRoot, root: target }) ? 0 : 3);
  // Inside the checkout the clone must be ignored: its own edits are copied from the
  // checkout's untracked files, and an unignored clone would copy itself into itself.
  // check-ignore exits 0 ignored, 1 not ignored, 128 for a path outside the repository.
  if (spawnSync('git', ['-C', repoRoot, 'check-ignore', '-q', '--no-index', target]).status === 1) {
    throw new Error(`refusing to clone into ${target}: it is not ignored by ${repoRoot}`);
  }
  if (existsSync(target)) {
    try {
      removeLane({ repoRoot, laneRoot: target });
    } catch (error) {
      throw new Error(`refusing to replace ${target}: it is not a served E2E clone of ${repoRoot} (${error.message})`);
    }
  }
  process.stdout.write(`${realpathSync(cloneIsolatedCheckout({ repoRoot, root: target }))}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
}
