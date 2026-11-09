import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
 *
 * The supervisor, not its starter, claims the name: it is the process that lives as long as the
 * job, so no starter's death leaves a claim behind or a job unclaimed. The claim is one SQLite
 * write transaction on `<name>.job.db`. The database serializes claimants, and the operating
 * system drops a dead claimant's file lock, so nothing is ever taken over by age or by guess.
 */

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** How long a start waits for its supervisor to claim the name before it gives up. */
const READY_TIMEOUT_MS = 30_000;
/** How long one claimant waits for another's transaction, which holds a few statements. */
const CLAIM_BUSY_MS = 10_000;

export interface JobRecord { name: string; pid: number; start?: string; command: string[]; startedAt: string }
export interface JobPaths { log: string; exitFile: string; record: string }
export type JobStatus =
  | { name: string; state: 'running'; pid: number; log: string; exitFile: string }
  | { name: string; state: 'exited'; pid: number; exitCode?: number; log: string; exitFile: string };

export class JobError extends Error {}

export function jobDirectory(dir: string | undefined, env: NodeJS.ProcessEnv): string {
  return resolve(dir ?? env.TMPDIR ?? tmpdir());
}

export function jobPaths(dir: string, name: string): JobPaths {
  if (!NAME.test(name)) throw new JobError(`Invalid job name ${JSON.stringify(name)}: use 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit.`);
  return { log: join(dir, `${name}.log`), exitFile: join(dir, `${name}.exit`), record: join(dir, `${name}.job.db`) };
}

const damaged = (paths: JobPaths, why: string) => new JobError(`The job record ${paths.record} cannot be used (${why}). Check that no process of this job runs, then delete it or choose another name.`);

function parseRecord(paths: JobPaths, text: unknown): JobRecord {
  let value: Partial<JobRecord> | null = null;
  try { value = JSON.parse(String(text)) as Partial<JobRecord> | null; } catch { /* refused below */ }
  const pid = value?.pid;
  if (!value || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 2 || typeof value.name !== 'string' || !Array.isArray(value.command) || (value.start !== undefined && typeof value.start !== 'string')) {
    throw damaged(paths, 'it holds no job record');
  }
  return value as JobRecord;
}

/** Runs `use` on the record database. A file that is not one is a refusal, never an absent record:
 *  it may belong to a supervisor that still runs. */
function withRecords<T>(paths: JobPaths, options: { readOnly: boolean }, use: (db: DatabaseSync) => T): T {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(paths.record, options);
    db.exec(`PRAGMA busy_timeout = ${CLAIM_BUSY_MS}`);
    return use(db);
  } catch (error) {
    throw error instanceof JobError ? error : damaged(paths, error instanceof Error ? error.message : String(error));
  } finally { try { db?.close(); } catch { /* never opened */ } }
}

const selectRecord = (paths: JobPaths, db: DatabaseSync): JobRecord | undefined => {
  const row = db.prepare('SELECT record FROM job WHERE id = 1').get();
  return row === undefined ? undefined : parseRecord(paths, row.record);
};

function readRecord(paths: JobPaths): JobRecord | undefined {
  if (!existsSync(paths.record)) return undefined;
  return withRecords(paths, { readOnly: true }, db => selectRecord(paths, db));
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

/** What the supervisor tells its starter: it holds the name, or another supervisor does. */
export type ClaimAnswer = { claimed: true; replaced: boolean } | { claimed: false; pid: number } | { claimed: false; error: string };

/**
 * Claims `name` for this process, or answers who holds it. Read, decide and write are one write
 * transaction, so two claimants never both find the name free. A holder that has written its exit
 * file is done even while its process is still ending.
 */
export function claimJob(paths: JobPaths, record: JobRecord): ClaimAnswer {
  return withRecords(paths, { readOnly: false }, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('CREATE TABLE IF NOT EXISTS job (id INTEGER PRIMARY KEY CHECK (id = 1), record TEXT NOT NULL)');
      const previous = selectRecord(paths, db);
      if (previous && running(previous) && readExit(paths) === undefined) { db.exec('ROLLBACK'); return { claimed: false, pid: previous.pid }; }
      // An exit file that stays would resolve the next process wait at once with the old code.
      rmSync(paths.exitFile, { force: true });
      db.prepare('INSERT INTO job (id, record) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record').run(JSON.stringify(record));
      db.exec('COMMIT');
      return { claimed: true, replaced: previous !== undefined };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no transaction is open */ }
      throw error;
    }
  });
}

export interface StartOptions { name: string; dir: string; command: string[]; cwd?: string; env?: NodeJS.ProcessEnv }
export interface StartedJob { name: string; pid: number; log: string; exitFile: string; replaced: boolean }

/** Starts the supervisor and answers once it holds the name. Refuses while the name runs. */
export async function startJob(options: StartOptions): Promise<StartedJob> {
  const { name, dir, command } = options;
  if (command.length === 0) throw new JobError('Give the command to run after "--".');
  mkdirSync(dir, { recursive: true });
  const paths = jobPaths(dir, name);
  const [bin, ...prefix] = ownCommand();
  const { child } = await startOwnedGroup(bin!, [...prefix, 'job', SUPERVISE, dir, name, '--', ...command], {
    cwd: options.cwd ?? process.cwd(), env: options.env ?? process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const answer = await supervisorAnswer(child);
  if (!answer.claimed) {
    throw new JobError('pid' in answer ? `Job ${JSON.stringify(name)} is already running as PID ${answer.pid}. Wait for that PID, or choose another name.` : answer.error);
  }
  child.disconnect();
  child.unref();
  return { name, pid: child.pid!, log: paths.log, exitFile: paths.exitFile, replaced: answer.replaced };
}

/** The supervisor's claim answer; a refusal when it ends or stays silent first. */
function supervisorAnswer(child: ChildProcess): Promise<ClaimAnswer> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new JobError('The job supervisor did not start.')); }, READY_TIMEOUT_MS);
    const settle = (act: () => void) => { clearTimeout(timer); child.removeAllListeners('message'); child.removeAllListeners('exit'); act(); };
    child.once('message', answer => settle(() => done(answer as ClaimAnswer)));
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

/** Sends the claim answer to the starter over the channel it opened, then lets go of the channel. */
export function tellStarter(answer: ClaimAnswer): Promise<void> {
  return new Promise((sent) => {
    // A starter that has ended closed the channel: there is no one to tell.
    if (!process.send || !process.connected) { sent(); return; }
    try { process.send(answer, () => { if (process.connected) process.disconnect(); sent(); }); } catch { sent(); }
  });
}

/**
 * The supervisor: claims the name, tells its starter, runs the command and writes its exit code.
 * It answers 1 without running anything when another supervisor holds the name. The exit file is
 * renamed into place, so a reader never sees it half written. A SIGTERM or SIGINT goes on to the
 * command, and the exit file still records how it ended.
 */
export async function superviseJob(dir: string, name: string, command: string[], tell: (answer: ClaimAnswer) => Promise<void> = async () => {}): Promise<number> {
  const paths = jobPaths(dir, name);
  const start = processStartToken(process.pid);
  const record: JobRecord = { name, pid: process.pid, ...(start === undefined ? {} : { start }), command, startedAt: new Date().toISOString() };
  let answer: ClaimAnswer;
  try { answer = claimJob(paths, record); }
  catch (error) { answer = { claimed: false, error: error instanceof Error ? error.message : String(error) }; }
  if (!answer.claimed) { await tell(answer); return 1; }
  const log = openSync(paths.log, 'w');
  // A hangup must not end the supervisor: its starter's terminal or session may close.
  const signals: Array<[NodeJS.Signals, () => void]> = [['SIGHUP', () => {}]];
  // A starter that died gets no answer; the job runs all the same, and `status` names it.
  void tell(answer).catch(() => {});
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
