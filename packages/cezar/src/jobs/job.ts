import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { recordedProcessLive } from '../delegation/process-liveness.ts';
import { processStartToken, startOwnedGroup } from '../detached-process.ts';
import { ownCommand } from './command.ts';

/**
 * A long command an agent starts from its own shell and leaves running (hearsay-tools/cezarion#3097).
 * A supervisor process leads a session of its own, so the command outlives the shell call, the turn
 * and the agent session on every runner: Codex ends a command's process group when the command
 * returns, and Cezar ends a session's group when the session ends. The supervisor writes the
 * command's output to `<name>.log` and its exit code to `<name>.exit`, and its own PID is the one a
 * process wait watches.
 */

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** How long a start waits for its supervisor to record itself before it gives up. */
const READY_TIMEOUT_MS = 30_000;

export interface JobRecord { name: string; pid: number; start?: string; command: string[]; startedAt: string }
export interface JobPaths { log: string; exitFile: string; record: string; lock: string }
export type JobStatus =
  | { name: string; state: 'running'; pid: number; log: string; exitFile: string }
  | { name: string; state: 'exited'; pid: number; exitCode?: number; log: string; exitFile: string };

export class JobError extends Error {}

export function jobDirectory(dir: string | undefined, env: NodeJS.ProcessEnv): string {
  return resolve(dir ?? env.TMPDIR ?? tmpdir());
}

export function jobPaths(dir: string, name: string): JobPaths {
  if (!NAME.test(name)) throw new JobError(`Invalid job name ${JSON.stringify(name)}: use 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit.`);
  return { log: join(dir, `${name}.log`), exitFile: join(dir, `${name}.exit`), record: join(dir, `${name}.job.json`), lock: join(dir, `${name}.job.lock`) };
}

/** The record, `undefined` when there is none, or a refusal: a record that cannot be read or is
 *  not one may belong to a supervisor that still runs, so it never counts as absent. */
function readRecord(paths: JobPaths): JobRecord | undefined {
  let text: string;
  try { text = readFileSync(paths.record, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new JobError(`Cannot read the job record ${paths.record}: ${(error as Error).message}`);
  }
  let value: Partial<JobRecord> | null = null;
  try { value = JSON.parse(text) as Partial<JobRecord> | null; } catch { /* not JSON: refused below */ }
  const pid = value?.pid;
  if (!value || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 2 || typeof value.name !== 'string' || !Array.isArray(value.command) || (value.start !== undefined && typeof value.start !== 'string')) {
    throw new JobError(`The job record ${paths.record} is not a job record. Check that no process of this job runs, then delete it or choose another name.`);
  }
  return value as JobRecord;
}

/** The first line of the exit file as an integer, when the supervisor has written it. */
function readExit(paths: JobPaths): number | undefined {
  try {
    const line = readFileSync(paths.exitFile, 'utf8').split('\n', 1)[0]!.trim();
    return /^-?\d+$/.test(line) ? Number(line) : undefined;
  } catch { return undefined; }
}

/** A record whose supervisor still runs. Without a start identity (Windows) a live PID counts. */
function running(record: JobRecord): boolean {
  return recordedProcessLive({ pid: record.pid, ...(record.start === undefined ? {} : { startToken: record.start }) });
}

export function jobStatus(dir: string, name: string): JobStatus {
  const paths = jobPaths(dir, name);
  const record = readRecord(paths);
  if (!record) throw new JobError(`No job named ${JSON.stringify(name)} in ${dir}.`);
  const base = { name, pid: record.pid, log: paths.log, exitFile: paths.exitFile };
  const exitCode = readExit(paths);
  if (exitCode !== undefined) return { ...base, state: 'exited', exitCode };
  return running(record) ? { ...base, state: 'running' } : { ...base, state: 'exited' };
}

interface StartLock { pid: number; start?: string; token: string }

function readStartLock(paths: JobPaths): StartLock | undefined {
  try {
    const value = JSON.parse(readFileSync(paths.lock, 'utf8')) as Partial<StartLock>;
    return typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && typeof value.token === 'string' ? value as StartLock : undefined;
  } catch { return undefined; }
}

/**
 * One start at a time per name. The lock file is linked into place whole, so it always names its
 * holder, and it is taken over only from a holder that is proven gone: a start that is merely slow
 * keeps it. A lock that names no holder is never taken over.
 */
function takeStartLock(paths: JobPaths): string {
  const token = randomUUID();
  const start = processStartToken(process.pid);
  const mine = `${paths.lock}.${token}`;
  writeFileSync(mine, JSON.stringify({ pid: process.pid, ...(start === undefined ? {} : { start }), token } satisfies StartLock));
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { linkSync(mine, paths.lock); return token; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const holder = readStartLock(paths);
      if (!holder || recordedProcessLive({ pid: holder.pid, ...(holder.start === undefined ? {} : { startToken: holder.start }) })) break;
      // Remove only the dead holder's lock: another start may have taken it over since the read.
      if (readStartLock(paths)?.token === holder.token) rmSync(paths.lock, { force: true });
    }
    throw new JobError(`Another start of this job holds ${paths.lock}. Run the status command, then retry. If no start runs, delete that file.`);
  } finally { rmSync(mine, { force: true }); }
}

/** Whether this start still holds the lock: a takeover that raced a dead holder's removal can displace it. */
function holdsStartLock(paths: JobPaths, token: string): boolean {
  return readStartLock(paths)?.token === token;
}

export interface StartOptions { name: string; dir: string; command: string[]; cwd?: string; env?: NodeJS.ProcessEnv }
export interface StartedJob { name: string; pid: number; log: string; exitFile: string; replaced: boolean }

/** Starts the supervisor and answers once it has recorded itself. Refuses while the name runs. */
export async function startJob(options: StartOptions): Promise<StartedJob> {
  const { name, dir, command } = options;
  if (command.length === 0) throw new JobError('Give the command to run after "--".');
  mkdirSync(dir, { recursive: true });
  const paths = jobPaths(dir, name);
  const lock = takeStartLock(paths);
  try {
    const previous = readRecord(paths);
    if (previous && running(previous) && readExit(paths) === undefined) {
      throw new JobError(`Job ${JSON.stringify(name)} is already running as PID ${previous.pid}. Wait for that PID, or choose another name.`);
    }
    if (!holdsStartLock(paths, lock)) throw new JobError(`Another start of this job took over ${paths.lock}. Run the status command, then retry.`);
    // An exit file that stays would resolve the next process wait at once with the old code.
    rmSync(paths.exitFile, { force: true });
    const [bin, ...prefix] = ownCommand();
    const { child } = await startOwnedGroup(bin!, [...prefix, 'job', SUPERVISE, dir, name, '--', ...command], {
      cwd: options.cwd ?? process.cwd(), env: options.env ?? process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    await supervisorReady(child);
    child.disconnect();
    child.unref();
    return { name, pid: child.pid!, log: paths.log, exitFile: paths.exitFile, replaced: previous !== undefined };
  } finally {
    if (holdsStartLock(paths, lock)) rmSync(paths.lock, { force: true });
  }
}

/** Resolves on the supervisor's ready message; rejects when it ends or stays silent first. */
function supervisorReady(child: ChildProcess): Promise<void> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new JobError('The job supervisor did not start.')); }, READY_TIMEOUT_MS);
    const settle = (act: () => void) => { clearTimeout(timer); child.removeAllListeners('message'); child.removeAllListeners('exit'); act(); };
    child.once('message', () => settle(done));
    child.once('exit', code => settle(() => fail(new JobError(`The job supervisor ended before it started the command (exit ${code ?? 'by signal'}).`))));
  });
}

/** The hidden subcommand the supervisor runs as. */
export const SUPERVISE = '__supervise';

function writeAtomic(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

const signalNumber = (signal: NodeJS.Signals): number => constants.signals[signal] ?? 0;

/** Tells the starter, over the channel it opened, that the record is written; then lets go of it. */
export function tellStarter(): void {
  if (process.send) process.send('ready', () => { if (process.connected) process.disconnect(); });
}

/**
 * The supervisor: records itself, tells its starter, runs the command and writes its exit code.
 * The exit file is renamed into place, so a reader never sees it half written. A SIGTERM or
 * SIGINT goes on to the command, and the exit file still records how it ended.
 */
export function superviseJob(dir: string, name: string, command: string[], ready: () => void = () => {}): Promise<number> {
  const paths = jobPaths(dir, name);
  const start = processStartToken(process.pid);
  const record: JobRecord = { name, pid: process.pid, ...(start === undefined ? {} : { start }), command, startedAt: new Date().toISOString() };
  writeAtomic(paths.record, `${JSON.stringify(record)}\n`);
  const log = openSync(paths.log, 'w');
  // A hangup must not end the supervisor: its starter's terminal or session may close.
  const signals: Array<[NodeJS.Signals, () => void]> = [['SIGHUP', () => {}]];
  ready();
  return new Promise((done) => {
    const finish = (code: number, note?: string) => {
      for (const [signal, handler] of signals) process.off(signal, handler);
      if (note) writeFileSync(log, `${note}\n`);
      closeSync(log);
      writeAtomic(paths.exitFile, `${code}\n`);
      done(code);
    };
    const child = spawn(command[0]!, command.slice(1), { stdio: ['ignore', log, log] });
    for (const signal of ['SIGTERM', 'SIGINT'] as const) signals.push([signal, () => { child.kill(signal); }]);
    for (const [signal, handler] of signals) process.on(signal, handler);
    child.once('error', error => finish(127, `cez job: cannot run ${command[0]}: ${error.message}`));
    child.once('exit', (code, signal) => finish(code ?? 128 + (signal ? signalNumber(signal) : 0)));
  });
}
