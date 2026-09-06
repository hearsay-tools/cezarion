import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);

it('headless completion cancels a slow repository lookup instead of waiting for its timeout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-headless-repo-'));
  const bin = join(root, 'bin');
  const pidFile = join(root, 'gh.pid');
  const stopped = join(root, 'gh.stopped');
  mkdirSync(bin);
  // Only discovery hangs; any unrelated GitHub probe fails quickly and quietly.
  const fakeGh = join(bin, 'gh');
  writeFileSync(fakeGh, `#!${process.execPath}
const fs = require('node:fs');
if (!process.argv.includes('nameWithOwner')) process.exit(1);
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on('SIGTERM', () => {
  fs.writeFileSync(${JSON.stringify(stopped)}, 'cancelled');
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
      timeout: 8000,
      maxBuffer: 1024 * 1024,
    }).then((output) => ({ ...output, killed: false }), (error: { stdout: string; killed: boolean }) => error);
    expect(result.stdout).toMatch(/run (done|review)/);
    expect(existsSync(pidFile)).toBe(true);
    expect(result.killed, 'CLI must exit without waiting for the 15-second GitHub timeout').toBe(false);
    expect(existsSync(stopped)).toBe(true);
    const records = JSON.parse(readFileSync(join(root, '.ai/cezar/runs.json'), 'utf8'));
    expect(records).toHaveLength(1);
    expect(['done', 'review']).toContain(records[0].status);
  } finally {
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch { /* already exited */ }
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}, 15000);
