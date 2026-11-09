import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
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
/** A start that died between taking the lock and releasing it holds it no longer than this. */
const START_LOCK_STALE_MS = 30_000;
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

function readRecord(paths: JobPaths): JobRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(paths.record, 'utf8')) as Partial<JobRecord>;
    return Number.isSafeInteger(value.pid) && typeof value.name === 'string' && Array.isArray(value.command) ? value as JobRecord : undefined;
  } catch { return undefined; }
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

/** One start at a time per name: `mkdir` is atomic, and a lock a dead start left is taken over. */
function takeStartLock(paths: JobPaths, now: () => number): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { mkdirSync(paths.lock); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let age: number;
      try { age = now() - statSync(paths.lock).mtimeMs; } catch { continue; }
      if (age < START_LOCK_STALE_MS) break;
      try { rmdirSync(paths.lock); } catch { /* another start took it over first */ }
    }
  }
  throw new JobError(`Another start of this job is in progress in ${paths.lock}. Run the status command, then retry.`);
}

export interface StartOptions { name: string; dir: string; command: string[]; cwd?: string; env?: NodeJS.ProcessEnv; now?: () => number }
export interface StartedJob { name: string; pid: number; log: string; exitFile: string; replaced: boolean }

/** Starts the supervisor and answers once it has recorded itself. Refuses while the name runs. */
export async function startJob(options: StartOptions): Promise<StartedJob> {
  const { name, dir, command, now = Date.now } = options;
  if (command.length === 0) throw new JobError('Give the command to run after "--".');
  mkdirSync(dir, { recursive: true });
  const paths = jobPaths(dir, name);
  takeStartLock(paths, now);
  try {
    const previous = readRecord(paths);
    if (previous && running(previous) && readExit(paths) === undefined) {
      throw new JobError(`Job ${JSON.stringify(name)} is already running as PID ${previous.pid}. Wait for that PID, or choose another name.`);
    }
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
    try { rmdirSync(paths.lock); } catch { /* taken over after the stale bound */ }
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

/**
 * The supervisor: records itself, tells its starter, runs the command and writes its exit code.
 * The exit file is renamed into place, so a reader never sees it half written. A SIGTERM or
 * SIGINT goes on to the command, and the exit file still records how it ended.
 */
export function superviseJob(dir: string, name: string, command: string[]): Promise<number> {
  const paths = jobPaths(dir, name);
  const start = processStartToken(process.pid);
  const record: JobRecord = { name, pid: process.pid, ...(start === undefined ? {} : { start }), command, startedAt: new Date().toISOString() };
  writeAtomic(paths.record, `${JSON.stringify(record)}\n`);
  const log = openSync(paths.log, 'w');
  // A hangup must not end the supervisor: its starter's terminal or session may close.
  process.on('SIGHUP', () => {});
  if (process.send) process.send('ready', () => { if (process.connected) process.disconnect(); });
  return new Promise((done) => {
    const finish = (code: number, note?: string) => {
      if (note) writeFileSync(log, `${note}\n`);
      closeSync(log);
      writeAtomic(paths.exitFile, `${code}\n`);
      done(code);
    };
    const child = spawn(command[0]!, command.slice(1), { stdio: ['ignore', log, log] });
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { child.kill(signal); });
    child.once('error', error => finish(127, `cez job: cannot run ${command[0]}: ${error.message}`));
    child.once('exit', (code, signal) => finish(code ?? 128 + (signal ? signalNumber(signal) : 0)));
  });
}
