import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { readPersistedRuns } from './runs/run-store.testkit.ts';

const exec = promisify(execFile);
const CLI_TIMEOUT_MS = 30_000;
const DISCOVERY_CANCEL_TIMEOUT_MS = 12_000;

it.each(['slow', 'retry-delay'] as const)('headless completion cancels %s repository discovery promptly', async (mode) => {
  const root = mkdtempSync(join(tmpdir(), 'cez-headless-repo-'));
  const bin = join(root, 'bin');
  const pidFile = join(root, 'gh.pid');
  const started = join(root, 'gh.started');
  const stopped = join(root, 'gh.stopped');
  mkdirSync(bin);
  // Only discovery hangs; any unrelated GitHub probe fails quickly and quietly.
  const fakeGh = join(bin, 'gh');
  writeFileSync(fakeGh, `#!${process.execPath}
const fs = require('node:fs');
if (!process.argv.includes('nameWithOwner')) process.exit(1);
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
fs.writeFileSync(${JSON.stringify(started)}, String(Date.now()));
if (${JSON.stringify(mode)} === 'retry-delay') {
  fs.writeFileSync(${JSON.stringify(stopped)}, 'transient failure');
  process.stderr.write('network is unreachable');
  process.exit(1);
}
process.on('SIGTERM', () => {
  fs.writeFileSync(${JSON.stringify(stopped)}, String(Date.now()));
  process.exit(0);
});
setInterval(() => {}, 1000);
`);
  chmodSync(fakeGh, 0o755);
  try {
    const result = await exec(process.execPath, [
      '--import', 'tsx', fileURLToPath(new URL('./index.ts', import.meta.url)),
      'run', 'mock:done', '--repo', root,
    ], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, CEZ_DRY_RUN: '1', CEZ_HOME: join(root, 'home') },
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    }).catch((error: Error & { killed?: boolean; stdout?: string }) => {
      if (error.killed) {
        throw new Error(`headless CLI timed out after ${CLI_TIMEOUT_MS / 1000} seconds; stdout:\n${error.stdout ?? ''}`, { cause: error });
      }
      throw error;
    });
    expect(result.stdout).toMatch(/run (done|review)/);
    expect(existsSync(pidFile)).toBe(true);
    expect(existsSync(stopped)).toBe(true);
    // Start the promptness budget at the gh call, not at CLI startup: tsx startup
    // can be delayed by a full Vitest suite without delaying discovery cancellation.
    if (mode === 'slow') {
      expect(Number(readFileSync(stopped, 'utf8')) - Number(readFileSync(started, 'utf8')),
        'CLI must cancel discovery before the 15-second GitHub timeout').toBeLessThan(DISCOVERY_CANCEL_TIMEOUT_MS);
    }
    const records = readPersistedRuns(join(root, '.ai/cezar'));
    expect(records).toHaveLength(1);
    expect(['done', 'review']).toContain(records[0].status);
  } finally {
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch { /* already exited */ }
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}, CLI_TIMEOUT_MS + 10_000);
