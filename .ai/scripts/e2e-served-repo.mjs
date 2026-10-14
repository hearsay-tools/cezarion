#!/usr/bin/env node
// The project the shared E2E server serves: a fresh isolated clone of this checkout, never the
// checkout itself. Serving the checkout put the server's runs, task worktrees and every file a
// spec seeds into the checkout's own .ai/cezar — in the main checkout that is the live cockpit's
// data dir, which refuses a second server, and a successful boot would have written into it.
//
//   node .ai/scripts/e2e-served-repo.mjs <checkout> <target>          → prints the clone's root
//   node .ai/scripts/e2e-served-repo.mjs --sync <checkout> <target>   → exit 3: HEAD moved
//
// <target> is replaced only when a previous call created it (removeLane's ownership checks).
// --sync refreshes a reused server's clone in place: the server used to read the checkout live,
// so an edited skill or workflow must reach it without a reboot.
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
