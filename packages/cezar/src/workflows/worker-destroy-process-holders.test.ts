import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { nonDumpableHolder } from '../delegation/non-dumpable.testkit.ts';
import { requirePidText } from '../pid-file.testkit.ts';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { agentTmpDir } from '../runs/agent-tmpdir.ts';
import { ensureOwnedWorkspace } from '../delegation/workspace.ts';
import { installIdentityFileStore } from '../delegation/identity-file-store.ts';
import { posixIdentityFileStore } from '../delegation/posix-workspace-identity.ts';
import * as runners from '../core/runner-factory.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { RunManager } from './run.ts';
import { acquireInertCiResources } from '../ci-wait/inert-ci-resources.testkit.ts';
import { DelegationService } from '../delegation/service.ts';
import { processesWithCwdUnder } from '../delegation/process-liveness.ts';
import { signalSession, spawnSessionLeader } from '../core/session-process.ts';
import { until, root, store, manager, releases, worker, workspace, useWorkerDestroyFixture } from './worker-destroy.testkit.ts';
import { createRunner } from '../core/runner-factory.ts';
import { workerCleanups } from '../delegation/worker-cleanup.ts';

describe('worker termination barrier', { timeout: 30_000 }, () => {
 useWorkerDestroyFixture();
  describe('unreadable processes at destroy (hearsay-tools/cezarion#889)', () => {
    const branchExists = (branch: string) => execFileSync('git', ['branch', '--list', branch], { cwd: root, encoding: 'utf8' }).includes(branch);
    /** A settled worker with a materialized worktree; the scratch stays unmaterialized. */
    async function settled() {
      const w = await worker();
      // Admission runs before the worktree exists, so it never scans an ambient holder.
      const generation = store.commitWorkerExecutionStart(w.id);
      await ensureOwnedWorkspace(root, w);
      setRunStatus(store, w.id, RUN_STATUS.done); store.commitWorkerExecutionComplete(w.id, generation); store.flush();
      const service = new DelegationService(workerCleanups()); const detach = service.registerProject({ home: testHome(), id: 'p', root, store, manager });
      return { w, service, detach };
    }

    // Login sshd, systemd --user and gpg-agent are non-dumpable, so their cwds are unreadable.
    // Neither their age nor their parent chain matters any more: an unreadable cwd is no evidence.
    it.runIf(process.platform === 'linux')('completes when the only unreadable cwds belong to session daemons and a later sshd', async () => {
      const daemons = [await nonDumpableHolder(root)];
      const { w, service, detach } = await settled();
      const later = [await nonDumpableHolder(tmpdir()), await nonDumpableHolder(workspace(w).path)];
      try {
        expect(await service.destroyForHuman('p', w.id)).toMatchObject({ state: 'complete', remaining: [] });
        expect(existsSync(workspace(w).path)).toBe(false); expect(branchExists(workspace(w).branch)).toBe(false);
        for (const holder of [...daemons, later[0]!]) await holder.write(); // never signalled
        expect(later[1]!.running).toBe(true); // its cwd is gone, so it cannot write; nothing signalled it
      } finally { detach(); for (const holder of [...daemons, ...later]) await holder.close(); }
    });

    it('win32 has no cwd scan: destroy removes an unheld worktree instead of staying unknown', async () => {
      const { w, service, detach } = await settled();
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      // Windows refuses to delete a directory a process holds, so the checked removal is the proof there.
      // Only the process scan is Windows here: the identity files stay on this host's POSIX store.
      installIdentityFileStore(posixIdentityFileStore);
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      try {
        expect(await service.destroyForHuman('p', w.id)).toMatchObject({ state: 'complete', remaining: [] });
      } finally { Object.defineProperty(process, 'platform', platform); installIdentityFileStore(undefined); detach(); }
      expect(existsSync(workspace(w).path)).toBe(false); expect(branchExists(workspace(w).branch)).toBe(false);
    });

    it('win32 admission is judged by recorded processes: a live one refuses reuse, and Continue works once it exits', async () => {
      const w = await worker();
      const generation = store.commitWorkerExecutionStart(w.id);
      await ensureOwnedWorkspace(root, w);
      const recorded = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(()=>{},1000)"], { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'ignore'] });
      const exited = new Promise(resolve => recorded.once('exit', resolve));
      releases.push(() => recorded.kill('SIGKILL'));
      await new Promise(resolve => recorded.stdout!.once('data', resolve));
      expect(store.appendWorkerProcess(w.id, generation, recorded.pid!)).toBe(true);
      setRunStatus(store, w.id, RUN_STATUS.done); store.commitWorkerExecutionComplete(w.id, generation); store.flush();
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      // No cwd scan exists on win32 (hearsay-tools/cezarion#889). Before, an `unknown` scan refused
      // every materialized worker's next generation, so Continue never worked there.
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      try {
        expect(() => store.commitWorkerExecutionStart(w.id)).toThrow(/reuse is not proven safe/);
        recorded.kill('SIGKILL'); await exited;
        expect(store.commitWorkerExecutionStart(w.id)).not.toBe(generation);
      } finally { Object.defineProperty(process, 'platform', platform); }
    });

    it.each(['worktree', 'scratch'] as const)('retains resources and names the PID of a process whose cwd is in the %s', async location => {
      const { w, service, detach } = await settled();
      const cwd = location === 'worktree' ? workspace(w).path : agentTmpDir(join(root, '.ai/cezar'), w.id);
      mkdirSync(cwd, { recursive: true });
      const holder = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(()=>{},1000)"], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
      const exited = new Promise(resolve => holder.once('exit', resolve));
      releases.push(() => holder.kill('SIGKILL'));
      await new Promise(resolve => holder.stdout!.once('data', resolve));
      try {
        const result = await service.destroyForHuman('p', w.id);
        expect(result).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
        expect(result.error).toContain(String(holder.pid));
        expect(existsSync(workspace(w).path)).toBe(true); expect(holder.exitCode).toBeNull(); expect(holder.signalCode).toBeNull();
        holder.kill('SIGKILL'); await exited;
        expect(await service.destroyForHuman('p', w.id)).toMatchObject({ state: 'complete', remaining: [] });
      } finally { holder.kill('SIGKILL'); await exited; detach(); }
    });
  });

  // hearsay-tools/cezarion#890: the leader is spawned as a runner spawns it, in its own process
  // group, and leaves one member working in the worktree.
  describe('agent session process groups (hearsay-tools/cezarion#890)', () => {
    type Entry = { pid: number; startToken?: string; pgid?: number };
    const recordPath = (id: string) => join(root, '.ai/cezar/runs', `${id}.processes.json`);
    const readRecord = (id: string) => JSON.parse(readFileSync(recordPath(id), 'utf8')) as { generation: string; controller: Entry; processes: Entry[] };
    const branchExists = (branch: string) => execFileSync('git', ['branch', '--list', branch], { cwd: root, encoding: 'utf8' }).includes(branch);
    /** A zombie has exited; only its reaper's wait remains. */
    const alive = (pid: number) => {
      try { process.kill(pid, 0); } catch { return false; }
      if (process.platform !== 'linux') return true;
      try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 1).trim()[0] !== 'Z'; } catch { return false; }
    };

    /** `member`: a SIGTERM-ignoring child in the leader's group, or a SIGTERM-sensitive one that
     * left it with setsid. `leader`: stays up, or exits 0 on its own once the member runs. Before
     * it exits, one scan sees the member as its descendant, so the fixture's scoped enumeration
     * still counts it after it is reparented. */
    async function groupedWorker(opts: { member: 'group' | 'setsid'; leader: 'stay' | 'exit' }) {
      const w = await worker();
      const member = opts.member === 'setsid' ? "process.on('SIGTERM',()=>process.exit(42)); setInterval(()=>{},1000)" : "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)";
      const script = `const m = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(member)}], { stdio: 'ignore', detached: ${opts.member === 'setsid'} });
console.log(String(m.pid)); ${opts.leader === 'exit' ? "m.unref(); process.stdin.on('end', () => process.exit(0)).resume();" : 'setInterval(()=>{},1000);'}`;
      let leader: ChildProcessWithoutNullStreams | undefined; let ready!: (pid: number) => void;
      const memberPid = new Promise<number>(resolve => { ready = resolve; });
      vi.spyOn(runners, 'createRunner').mockReturnValue({ backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent', interrupt: async () => undefined,
        run: async () => { throw Error('unused'); }, startSession: () => {
          const proc = spawnSessionLeader(process.execPath, ['-e', script], { cwd: workspace(w).path, env: process.env });
          leader = proc;
          releases.push(() => { try { process.kill(-proc.pid!, 'SIGKILL'); } catch { /* gone */ } });
          proc.stdout.once('data', chunk => ready(requirePidText(String(chunk), 'member stdout')));
          const result = new Promise<{ text: string; toolCalls: []; tokensUsed: number }>(resolve => proc.once('exit', () => resolve({ text: '', toolCalls: [], tokensUsed: 0 })));
          return { pid: proc.pid, result, open: true, sendMessage: () => true, sendAgentMessage: () => Promise.resolve(), discardQueuedMessages: () => {}, holdsHumanInput: () => false,
            interrupt: () => signalSession(proc, 'SIGTERM'), end: () => signalSession(proc, 'SIGTERM') };
        } });
      manager.enqueueOwnedRun(w.id);
      const pid = await memberPid;
      releases.push(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
      expect(processesWithCwdUnder(workspace(w).path)).toContain(pid);
      if (opts.leader === 'exit') leader!.stdin.end();
      return { w, leader: leader!, member: pid };
    }

    it("the ledger records the session leader's process group", async () => {
      const { w, leader } = await groupedWorker({ member: 'group', leader: 'stay' });
      await until(() => existsSync(recordPath(w.id)) && readRecord(w.id).processes.length === 1);
      expect(readRecord(w.id)).toMatchObject({ generation: store.readWorkerExecution(w.id)!.generation,
        processes: [{ pid: leader.pid, pgid: leader.pid, ...(process.platform === 'linux' ? { startToken: expect.any(String) } : {}) }] });
    });

    const service = (projectStore: RunStore, projectManager: RunManager) => {
      const delegation = new DelegationService(workerCleanups()); delegation.registerProject({ home: testHome(), id: 'p', root, store: projectStore, manager: projectManager });
      return delegation;
    };

    it.skipIf(process.platform === 'win32')("destroy ends a finished worker's leftover in its process group", async () => {
      const { w, member } = await groupedWorker({ member: 'group', leader: 'exit' });
      await until(() => !manager.isActive(w.id) && store.readWorkerExecution(w.id)?.phase === 'complete');
      expect(alive(member)).toBe(true);
      expect(await service(store, manager).destroyForHuman('p', w.id)).toMatchObject({ state: 'complete', remaining: [] });
      expect(alive(member)).toBe(false);
      expect(existsSync(workspace(w).path)).toBe(false); expect(branchExists(workspace(w).branch)).toBe(false);
    });

    it.skipIf(process.platform === 'win32')("destroy reaps a crashed generation's recorded group after its leader died", async () => {
      const { w, leader, member } = await groupedWorker({ member: 'group', leader: 'stay' });
      await until(() => existsSync(recordPath(w.id)) && readRecord(w.id).processes.length === 1);
      manager.dispose(); setRunStatus(store, w.id, RUN_STATUS.failed); store.flush();
      const corpse = spawn(process.execPath, ['-e', '']); await new Promise(resolve => corpse.once('exit', resolve));
      writeFileSync(recordPath(w.id), JSON.stringify({ ...readRecord(w.id), controller: { pid: corpse.pid!, startToken: '1' } }));
      // Only the leader dies: its member keeps the group, and the worktree, alive.
      const gone = new Promise(resolve => leader.once('exit', resolve)); process.kill(leader.pid!, 'SIGKILL'); await gone;
      expect(alive(member)).toBe(true);
      store.close(); const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true }); const other = new RunManager(reopened, root, { acquireCiResources: acquireInertCiResources, createRunner, home: testHome() });
      try {
        expect(await service(reopened, other).destroyForHuman('p', w.id)).toMatchObject({ state: 'complete', remaining: [] });
        expect(alive(member)).toBe(false);
        expect(existsSync(workspace(w).path)).toBe(false);
      } finally { other.dispose(); reopened.flush(); }
    });

    it.skipIf(process.platform === 'win32')("destroy never signals a dead leader's recorded group that holds nothing of the worker", async () => {
      const w = await worker();
      const generation = store.commitWorkerExecutionStart(w.id);
      await ensureOwnedWorkspace(root, w);
      setRunStatus(store, w.id, RUN_STATUS.done); store.commitWorkerExecutionComplete(w.id, generation); store.flush();
      // An unrelated group whose number equals the recorded leader's pid, its leader already gone:
      // the shape a double-fork daemon leaves once a freed number is reused.
      const script = `const m = require('child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: 'ignore' }); console.log(String(m.pid)); m.unref(); setTimeout(() => process.exit(0), 50);`;
      const foreign = spawn(process.execPath, ['-e', script], { cwd: tmpdir(), detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const member = requirePidText(String(await new Promise<Buffer>(resolve => foreign.stdout!.once('data', resolve))), 'member stdout');
      releases.push(() => { try { process.kill(member, 'SIGKILL'); } catch { /* gone */ } });
      await new Promise(resolve => foreign.once('exit', resolve));
      expect(alive(member)).toBe(true);
      writeFileSync(recordPath(w.id), JSON.stringify({ ...readRecord(w.id), processes: [{ pid: foreign.pid!, pgid: foreign.pid! }] }));
      const kills = vi.spyOn(process, 'kill');
      expect(await service(store, manager).destroyForHuman('p', w.id)).toMatchObject({ state: 'complete', remaining: [] });
      expect(kills.mock.calls.filter(([pid, signal]) => pid === -foreign.pid! && signal !== 0)).toEqual([]);
      expect(alive(member)).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('a setsid child keeps destroy incomplete and is never signalled', async () => {
      const { w, member } = await groupedWorker({ member: 'setsid', leader: 'exit' });
      await until(() => !manager.isActive(w.id) && store.readWorkerExecution(w.id)?.phase === 'complete');
      const kills = vi.spyOn(process, 'kill');
      const result = await service(store, manager).destroyForHuman('p', w.id);
      expect(result).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
      expect(result.error).toContain(String(member));
      expect(alive(member)).toBe(true);
      expect(kills.mock.calls.filter(([pid, signal]) => Math.abs(pid) === member && signal !== 0)).toEqual([]);
      expect(existsSync(workspace(w).path)).toBe(true);
    });
  });
});
