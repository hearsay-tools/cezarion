import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { processStartToken, startAndForget } from '../detached-process.ts';
import { probeProcessWait } from '../process-wait/supervisor.ts';
import { runJobCommand } from './cli.ts';
import { jobStartCommand, ownCommand } from './command.ts';
import { claimJob, jobPaths, jobStatus, startJob, superviseJob } from './job.ts';

const run = promisify(execFile);
const dirs: string[] = [];
const pids: number[] = [];
function scratch(): string { const dir = mkdtempSync(join(tmpdir(), 'cez-job-')); dirs.push(dir); return dir; }
afterEach(() => {
  vi.restoreAllMocks();
  for (const pid of pids.splice(0)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already ended */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Resolves once `path` exists: the supervisor renames its exit file into place when the job ends. */
async function written(path: string): Promise<void> {
  await vi.waitFor(() => { if (!existsSync(path)) throw new Error(`${path} is not written yet`); }, { timeout: 20_000, interval: 25 }); // bound: hang guard; the exit file is the job's own end signal
}

const posix = process.platform !== 'win32';
const node = (script: string) => [process.execPath, '-e', script];

it.runIf(posix)('a job started by a CLI process that has ended reports its real exit code to a process wait', async () => {
  const dir = scratch();
  const gate = join(dir, 'gate');
  const script = `const fs=require('fs');console.log('out');console.error('err');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(t);process.exit(7)}},20)`;
  // The starting process is a real CLI process, and `execFile` resolves only after it has ended.
  const { stdout } = await run('sh', ['-c', `${jobStartCommand()} build --dir "$1" -- "$2" -e "$3"`, 'sh', dir, process.execPath, script]);
  const started = JSON.parse(stdout) as { name: string; pid: number; log: string; exitFile: string; replaced: boolean };
  pids.push(started.pid);
  expect(started).toMatchObject({ name: 'build', log: join(dir, 'build.log'), exitFile: join(dir, 'build.exit'), replaced: false });
  // The supervisor leads its own session, which is what outlives a runner's group cleanup.
  const { stdout: ids } = await run('ps', ['-o', 'sid=,pgid=', '-p', String(started.pid)]);
  expect(ids.trim().split(/\s+/).map(Number)).toEqual([started.pid, started.pid]);
  const roots = { worktree: dir };
  const request = { pid: started.pid, exitFile: started.exitFile, deadline: new Date(Date.now() + 60_000).toISOString(), roots };
  expect(probeProcessWait(request, Date.now())).toBeUndefined();
  expect(jobStatus(dir, 'build')).toMatchObject({ state: 'running', pid: started.pid });
  writeFileSync(gate, '');
  await written(started.exitFile);
  expect(probeProcessWait(request, Date.now())).toMatchObject({ outcome: 'exit_file', exitCode: 7 });
  expect(readFileSync(started.log, 'utf8')).toBe('out\nerr\n');
  expect(jobStatus(dir, 'build')).toMatchObject({ state: 'exited', exitCode: 7 });
}, 30_000);

it.runIf(posix)('a second start of a running name refuses and names its PID; a name that ended starts again', async () => {
  const dir = scratch();
  const gate = join(dir, 'gate');
  const first = await startJob({ name: 'bench', dir, command: node(`const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(t)}},20)`) });
  pids.push(first.pid);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await runJobCommand(['start', 'bench', '--dir', dir, '--', ...node('')], {})).toBe(1);
  expect(JSON.parse(String(error.mock.calls[0]?.[0])).error).toContain(`already running as PID ${first.pid}`);
  writeFileSync(gate, '');
  await written(first.exitFile);
  const second = await startJob({ name: 'bench', dir, command: node('process.exit(3)') });
  pids.push(second.pid);
  expect(second).toMatchObject({ replaced: true });
  expect(second.pid).not.toBe(first.pid);
  await written(second.exitFile);
  expect(jobStatus(dir, 'bench')).toMatchObject({ state: 'exited', exitCode: 3, pid: second.pid });
}, 30_000);

it.runIf(posix)('a command that cannot run exits 127 with the reason in the log', async () => {
  const dir = scratch();
  const job = await startJob({ name: 'missing', dir, command: [join(dir, 'no-such-binary')] });
  pids.push(job.pid);
  await written(job.exitFile);
  expect(jobStatus(dir, 'missing')).toMatchObject({ state: 'exited', exitCode: 127 });
  expect(readFileSync(job.log, 'utf8')).toContain('cannot run');
}, 30_000);

it('the supervisor records itself, writes the output and the exit code, and leaves no signal handler', async () => {
  const dir = scratch();
  const before = process.listenerCount('SIGTERM');
  expect(await superviseJob(dir, 'inline', node("console.log('ran');process.exit(4)"))).toBe(4);
  const paths = jobPaths(dir, 'inline');
  expect(readFileSync(paths.log, 'utf8')).toBe('ran\n');
  expect(readFileSync(paths.exitFile, 'utf8')).toBe('4\n');
  expect(process.listenerCount('SIGTERM')).toBe(before);
  // The record names this live process, so only the exit file says the job ended.
  expect(jobStatus(dir, 'inline')).toMatchObject({ state: 'exited', exitCode: 4 });
  expect(await superviseJob(dir, 'killed', node("process.kill(process.pid,'SIGKILL')"))).toBe(137);
  expect(await superviseJob(dir, 'absent', [join(dir, 'no-such-binary')])).toBe(127);
});

const dead = (name: string) => ({ name, pid: 2 ** 22 + 7, start: 'boot:1', command: ['x'], startedAt: new Date().toISOString() });
const self = (name: string) => ({ name, pid: process.pid, start: processStartToken(process.pid)!, command: ['x'], startedAt: new Date().toISOString() });

it('status reads a record whose supervisor is gone and left no exit file as exited without a code', () => {
  const dir = scratch();
  expect(claimJob(jobPaths(dir, 'lost'), dead('lost'))).toEqual({ claimed: true, replaced: false });
  const status = jobStatus(dir, 'lost');
  expect(status).toMatchObject({ state: 'exited' });
  expect(status).not.toHaveProperty('exitCode');
});

it.runIf(posix)('a claim is refused while the holder runs, and taken from a holder that is gone or has written its exit file', () => {
  const dir = scratch();
  const paths = jobPaths(dir, 'claim');
  expect(claimJob(paths, self('claim'))).toEqual({ claimed: true, replaced: false });
  expect(claimJob(paths, dead('claim'))).toEqual({ claimed: false, pid: process.pid });
  expect(jobStatus(dir, 'claim')).toMatchObject({ state: 'running', pid: process.pid });
  // The holder wrote its exit file: it is done, though its process still ends.
  writeFileSync(paths.exitFile, '0\n');
  expect(claimJob(paths, dead('claim'))).toEqual({ claimed: true, replaced: true });
  expect(existsSync(paths.exitFile)).toBe(false);
  expect(claimJob(paths, self('claim'))).toEqual({ claimed: true, replaced: true });
});

it.runIf(posix)('of several starts of one name at once, exactly one runs the command', async () => {
  const dir = scratch();
  const gate = join(dir, 'gate');
  const marks = join(dir, 'marks');
  const script = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marks)},'x');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(t)}},20)`;
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => startJob({ name: 'race', dir, command: node(script) })));
  const started = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  for (const job of started) pids.push(job.pid);
  expect(started).toHaveLength(1);
  const refusals = results.flatMap(result => result.status === 'rejected' ? [String(result.reason)] : []);
  expect(refusals).toEqual(Array.from({ length: 3 }, () => expect.stringContaining(`already running as PID ${started[0]!.pid}`)));
  writeFileSync(gate, '');
  await written(started[0]!.exitFile);
  expect(readFileSync(marks, 'utf8')).toBe('x');
}, 60_000);

it.runIf(posix)('a supervisor whose starter has ended still claims the name and runs the command', async () => {
  const dir = scratch();
  // No channel to a starter: the supervisor has no one to tell.
  const [bin, ...prefix] = ownCommand();
  expect(await startAndForget(bin!, [...prefix, 'job', '__supervise', dir, 'orphan', '--', ...node('process.exit(8)')], { settleMs: 0 })).toBe(true);
  const paths = jobPaths(dir, 'orphan');
  await written(paths.exitFile);
  const status = jobStatus(dir, 'orphan');
  pids.push(status.pid);
  expect(status).toMatchObject({ state: 'exited', exitCode: 8 });
}, 30_000);

it.runIf(posix)('a record file that is not a record never counts as absent: start and status refuse, and nothing is replaced', async () => {
  const dir = scratch();
  const paths = jobPaths(dir, 'damaged');
  writeFileSync(paths.log, 'earlier output\n');
  writeFileSync(paths.record, 'this is not a database, and it is long enough to be read as one: '.repeat(4));
  await expect(startJob({ name: 'damaged', dir, command: node('') })).rejects.toThrow('cannot be used');
  expect(() => jobStatus(dir, 'damaged')).toThrow('cannot be used');
  rmSync(paths.record);
  const db = new DatabaseSync(paths.record);
  db.exec("CREATE TABLE job (id INTEGER PRIMARY KEY, record TEXT NOT NULL); INSERT INTO job VALUES (1, '{\"pid\":\"12\"}')");
  db.close();
  await expect(startJob({ name: 'damaged', dir, command: node('') })).rejects.toThrow('it holds no job record');
  expect(() => jobStatus(dir, 'damaged')).toThrow('it holds no job record');
  // Another program's database, and a job table that lost its row, are not a free name either.
  for (const schema of ['CREATE TABLE other (x)', 'CREATE TABLE job (id INTEGER PRIMARY KEY, record TEXT NOT NULL)']) {
    rmSync(paths.record);
    const other = new DatabaseSync(paths.record);
    other.exec(schema);
    other.close();
    await expect(startJob({ name: 'damaged', dir, command: node('') })).rejects.toThrow('cannot be used');
    expect(() => jobStatus(dir, 'damaged')).toThrow('cannot be used');
  }
  expect(readFileSync(paths.log, 'utf8')).toBe('earlier output\n');
  // A claimant that ended before its first commit leaves an empty file: that is a free name.
  writeFileSync(paths.record, '');
  expect(() => jobStatus(dir, 'damaged')).toThrow('No job named "damaged"');
  const job = await startJob({ name: 'damaged', dir, command: node('') });
  pids.push(job.pid);
  await written(job.exitFile);
}, 30_000);

it('answers usage errors as JSON on stderr with exit 1, and help with exit 0', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const dir = scratch();
  expect(await runJobCommand(['start', 'no-command', '--dir', dir], {})).toBe(1);
  expect(await runJobCommand(['start', '../escape', '--dir', dir, '--', 'true'], {})).toBe(1);
  expect(await runJobCommand(['status', 'absent', '--dir', dir], {})).toBe(1);
  expect(await runJobCommand(['stop', 'x'], {})).toBe(1);
  expect(error.mock.calls.map(call => JSON.parse(String(call[0])).error)).toEqual([
    expect.stringContaining('after "--"'), expect.stringContaining('Invalid job name'), expect.stringContaining('No job named "absent"'), expect.stringContaining('Usage: cez job start'),
  ]);
  expect(await runJobCommand(['--help'], {})).toBe(0);
  expect(log.mock.calls[0]?.[0]).toContain('cez job status');
  // A `--help` after `--` belongs to the command, not to `cez job`.
  expect(await runJobCommand(['status', 'absent', '--dir', dir, '--', '--help'], {})).toBe(1);
});
