import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCapacityFixture, type CapacityEvidence } from './authoritative-capacity-guard.testkit.ts';
import { expect, it, vi } from 'vitest';
import { fixture } from './service.testkit.ts';
import { ensureOwnedWorkspace } from './workspace.ts';
import * as reaper from './destroy-holders.ts';
import { AliasBudgetExceeded, AliasWorkBudget } from './linux-alias-model.ts';
import { readProcEvidence } from './linux-proc-evidence.ts';

/** This test is enabled only by the CI namespace supervisor. */
const directory = process.env.CZR_TEST_CAPACITY_DIR;
function capacityEvidence(directory: string): CapacityEvidence {
  const argv = readFileSync('/proc/1/cmdline', 'utf8').split('\0');
  if (argv.at(-1) === '') argv.pop();
  const root = argv[3] ?? '';
  const info = (path: string) => {
    const stat = lstatSync(path);
    return { canonical: realpathSync(path), directory: stat.isDirectory(), symlink: stat.isSymbolicLink(), uid: stat.uid, mode: stat.mode };
  };
  const nspid = (path: string) => readFileSync(path, 'utf8').split('\n').find(line => line.startsWith('NSpid:'))?.trim().split(/\s+/);
  return { directory, root, script: realpathSync(fileURLToPath(new URL('../../../../.github/scripts/linux-mount-alias-probe.py', import.meta.url))),
    argv, uid: process.geteuid?.(), pid: process.pid, nspid: nspid('/proc/self/status'), initNspid: nspid('/proc/1/status'),
    pidNamespace: readlinkSync('/proc/self/ns/pid'), initPidNamespace: readlinkSync('/proc/1/ns/pid'),
    mountNamespace: readlinkSync('/proc/self/ns/mnt'), initMountNamespace: readlinkSync('/proc/1/ns/mnt'),
    rootInfo: info(root), capacityInfo: info(directory), mountInfo: readFileSync('/proc/self/mountinfo', 'utf8'), tmpdir: process.env.TMPDIR };
}

it.skipIf(!directory)('measures a complete authoritative destroy in the private PID namespace', { timeout: 120_000 }, async () => {
  if (!directory) throw Error('capacity fixture missing');
  prepareCapacityFixture(() => capacityEvidence(directory), path => vi.stubEnv('TMPDIR', path));
  vi.stubEnv('CEZ_DELEGATION', '1');
  const f = fixture();
  let complete = false;
  try {
    if (!realpathSync(f.root).startsWith(directory + sep)) throw Error('capacity workspace escaped fixture');
    const { workerId } = await f.service.spawn(f.caller, { task: 'capacity', baseline: 'parent-head', requestId: randomUUID() });
    const generation = f.store.commitWorkerExecutionStart(workerId);
    const workspace = await ensureOwnedWorkspace(f.root, f.store.getRun(workerId)!);
    f.store.updateRun(workerId, { status: 'review', worktreePath: workspace.path, branch: workspace.branch });
    expect(f.store.commitWorkerExecutionComplete(workerId, generation)).toBe(true);
    const calls = vi.spyOn(reaper, 'reapDestroyHolders');
    const pids = readdirSync('/proc').filter(name => /^\d+$/.test(name));
    const metricsBudget = new AliasWorkBudget(1_000_000);
    let maps = 0, unavailable = 0;
    for (const pid of pids) {
      try { maps += readProcEvidence(`/proc/${pid}/maps`, metricsBudget).toString('utf8').split('\n').filter(Boolean).length; }
      catch (error) { if (error instanceof AliasBudgetExceeded) throw error; unavailable++; }
    }
    const mounts = readProcEvidence('/proc/self/mountinfo', metricsBudget).toString('utf8').split('\n').filter(Boolean).length;
    process.stdout.write(`capacity workload: ${pids.length} processes, ${maps} map lines, ${unavailable} maps unavailable, ${mounts} mounts\n`);
    const started = Date.now();
    const result = await f.service.destroy(f.caller, { workerId });
    process.stdout.write(`capacity result: ${JSON.stringify(result)}, ${calls.mock.calls.length} reaper calls, ${Date.now() - started} ms\n`);
    expect(result).toMatchObject({ state: 'complete', remaining: [] });
    expect(existsSync(workspace.path)).toBe(false);
    expect(calls.mock.calls.length).toBeGreaterThanOrEqual(4);
    const budgets = calls.mock.calls.map(args => args[4]);
    expect(budgets[0]).toBeDefined();
    expect(budgets.every(budget => budget === budgets[0])).toBe(true);
    complete = true;
  } finally {
    // A failed attempt leaves its entire private fixture for inspection.
    if (complete) await f.close();
    vi.restoreAllMocks(); vi.unstubAllEnvs();
  }
});
