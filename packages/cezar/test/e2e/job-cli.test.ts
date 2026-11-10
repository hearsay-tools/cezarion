import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

// hearsay-tools/cezarion#3097: the built CLI starts its supervisor from `dist`, without tsx.
test('the packaged cez job start outlives its starter and records the exit code', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-job-package-'));
  const cli = resolve('dist/index.js');
  const call = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [cli, 'job', ...args], { encoding: 'utf8', env: { ...process.env, TMPDIR: dir } }));
  let pid: number | undefined;
  try {
    const gate = join(dir, 'gate');
    const script = `const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(t);process.exit(9)}},20)`;
    // No --dir: the files go to $TMPDIR. `execFileSync` returns only after the starter has ended.
    const started = call('start', 'packaged', '--', process.execPath, '-e', script);
    pid = started.pid;
    assert.deepEqual({ name: started.name, replaced: started.replaced }, { name: 'packaged', replaced: false });
    assert.match(started.log, /packaged\.[0-9a-z]+-\d+\.log$/);
    assert.match(started.exitFile, /packaged\.[0-9a-z]+-\d+\.exit$/);
    assert.ok(started.log.startsWith(dir) && started.exitFile.startsWith(dir));
    assert.equal(call('status', 'packaged').state, 'running');
    assert.throws(() => call('start', 'packaged', '--', process.execPath, '-e', ''), new RegExp(`already running as PID ${pid}`));
    writeFileSync(gate, '');
    // bound: hang guard; the exit file is the job's own end signal
    for (let waited = 0; !existsSync(started.exitFile) && waited < 20_000; waited += 25) await delay(25);
    assert.equal(readFileSync(started.exitFile, 'utf8'), '9\n');
    assert.deepEqual(call('status', 'packaged'), { name: 'packaged', pid, log: started.log, exitFile: started.exitFile, state: 'exited', exitCode: 9 });
  } finally {
    if (pid !== undefined) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already ended */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});
