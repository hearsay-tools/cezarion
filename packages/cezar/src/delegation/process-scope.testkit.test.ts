import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { nonDumpableHolder } from './non-dumpable.testkit.ts';
import { inspectGeneration, processesWithCwdUnder, processStartToken, recordedProcessLive } from './process-liveness.ts';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';

describe.runIf(process.platform === 'linux')('fixture process enumeration safety', () => {
  it('retains real unrecorded non-dumpable holders and independently reads recorded PIDs outside the scope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-scope-holder-'));
    const original = fs.readdirSync;
    const restore = scopeFixtureProcesses();
    const holder = await nonDumpableHolder(root);
    let closed = false;
    try {
      // No age exclusion, even though the unreadable fixture child is outside this path.
      expect(inspectGeneration({ paths: [join(root, 'elsewhere')], since: Date.now() + 60_000 })).toMatchObject({ liveness: 'alive', pids: [holder.pid] });
      await holder.write();
      expect(readFileSync(join(root, 'holder-writes'), 'utf8')).toBe('still writable\n');
      await holder.close(); closed = true;
      expect(inspectGeneration({ paths: [root] }).liveness).toBe('gone');
      // The test runner's parent is deliberately absent from enumeration. Its recorded
      // identity still blocks the real probe; scoping must never filter recorded reads.
      expect(fs.readdirSync('/proc')).not.toContain(String(process.ppid));
      expect(inspectGeneration({ paths: [root], record: { generation: 'fixture',
        controller: { pid: process.pid, startToken: processStartToken(process.pid) },
        processes: [{ pid: process.ppid, startToken: processStartToken(process.ppid) }],
      } })).toMatchObject({ liveness: 'alive', pids: [process.ppid] });
    } finally {
      if (!closed) await holder.close();
      restore(); rmSync(root, { recursive: true, force: true });
    }
    expect(fs.readdirSync).toBe(original);
  });

  it('keeps an observed descendant after its launcher exits until the real holder exits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-scope-orphan-'));
    const restore = scopeFixtureProcesses();
    const launcher = spawn('python3', ['-u', '-c', `
import os, sys, time
pid = os.fork()
if pid:
    print(pid, flush=True)
    sys.stdin.readline()
else:
    while not os.path.exists('stop'):
        time.sleep(0.01)
`], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(launcher, 'exit');
    let holder: { pid: number; startToken?: string } | undefined;
    try {
      const [data] = await once(launcher.stdout, 'data');
      const pid = Number(String(data).trim());
      expect(Number.isSafeInteger(pid)).toBe(true);
      holder = { pid, startToken: processStartToken(pid) };
      expect(processesWithCwdUnder(root)).toContain(pid); // observe while ancestry is intact
      launcher.stdin.end(); await exited;
      expect(processesWithCwdUnder(root)).toContain(pid); // now reparented, still the same token
      writeFileSync(join(root, 'stop'), '');
      await vi.waitFor(() => expect(recordedProcessLive(holder!)).toBe(false));
      expect(inspectGeneration({ paths: [root] }).liveness).toBe('gone');
    } finally {
      writeFileSync(join(root, 'stop'), ''); launcher.stdin.end(); await exited;
      if (holder) await vi.waitFor(() => expect(recordedProcessLive(holder!)).toBe(false));
      restore(); rmSync(root, { recursive: true, force: true });
    }
  });
});
