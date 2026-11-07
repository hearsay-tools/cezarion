import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

type Claim = { pid: number; ticket: number; gitRunning: boolean };

/** One IPC message the keeper accepts over its channel. */
type KeeperMessage = { kind: string; id: number; cwd: string; args: string[]; timeout?: number; input?: string };
type CommandResult = { ok: boolean; stdout: string; stderr: string };

/** Run one queued Git command; without input git sees an empty stdin, exactly as before. */
function runGitCommand(
  execFile: typeof import('node:child_process').execFile, message: KeeperMessage,
): Promise<CommandResult> {
  return new Promise(resolve => {
    const child = execFile('git', message.args, { cwd: message.cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: message.timeout }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout ?? '', stderr: stderr || error?.message || '' });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(message.input ?? '');
  });
}

export async function readMutationClaim(
  path: string, platform: NodeJS.Platform, probe: (pid: number) => void,
): Promise<Claim | undefined> {
  let value: Claim;
  try { value = JSON.parse(await fs.readFile(path, 'utf8')) as Claim; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isSafeInteger(value.ticket) || value.ticket < 0) throw new Error('invalid worktree mutation claim');
  // POSIX group lifetime survives the death of its keeper/leader: Git and
  // its children inherit this group. Only ESRCH proves EVERY member gone.
  // Do not replace this kernel probe with a PID/ps snapshot (forks can race it).
  if (platform === 'win32') {
    try { probe(value.pid); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        // Re-read AFTER death is established. The first idle snapshot may
        // predate a last command's busy publication and spawn. The unique
        // filename cannot now be updated by its dead owner or a new keeper.
        let final: Claim;
        try { final = JSON.parse(await fs.readFile(path, 'utf8')) as Claim; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        if (final && final.pid === value.pid && Number.isSafeInteger(final.ticket) && final.ticket >= 0 && final.gitRunning === false) {
          await fs.unlink(path).catch(() => undefined);
          return;
        }
        throw new Error('cannot prove a dead worktree keeper has no surviving Git children on Windows');
      }
    }
    return value;
  }
  try { probe(-value.pid); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      // Each claimant owns a unique filename, so recovery cannot unlink a new
      // owner's lock (the ABA race of unlinking/replacing one shared lockfile).
      await fs.unlink(path).catch(() => undefined);
      return;
    }
    // EPERM/unknown means possibly alive: never steal that claim.
  }
  return value;
}

/**
 * Lamport bakery: choose a ticket above every visible ticket.
 * Atomic rename keeps readers from observing partial JSON.
 */
async function selectTicket(
  directory: string, name: string, read: (entry: string) => Promise<Claim | undefined>,
): Promise<number> {
  let ticket = 1;
  for (const entry of await fs.readdir(directory)) {
    if (!entry.endsWith('.json') || entry === name) continue;
    const claim = await read(entry);
    if (claim) ticket = Math.max(ticket, claim.ticket + 1);
  }
  return ticket;
}

/** A peer holds the turn while it is still choosing or holds a smaller (ticket, name) pair. */
function hasPriority(claim: Claim, ticket: number, entry: string, name: string): boolean {
  return claim.ticket === 0 || claim.ticket < ticket || (claim.ticket === ticket && entry < name);
}

/** Wait for choosing peers and smaller (ticket, name) pairs, or give up. */
async function waitForTurn(
  directory: string, name: string, ticket: number,
  options: { read: (entry: string) => Promise<Claim | undefined>; isStopping: () => boolean; deadline: number; wait: () => Promise<void> },
): Promise<'ready' | 'timeout' | 'stopped'> {
  for (;;) {
    if (options.isStopping()) return 'stopped';
    let blocked = false;
    for (const entry of await fs.readdir(directory)) {
      if (!entry.endsWith('.json') || entry === name) continue;
      const claim = await options.read(entry);
      if (claim && hasPriority(claim, ticket, entry, name)) { blocked = true; break; }
    }
    if (!blocked) return 'ready';
    if (Date.now() >= options.deadline) return 'timeout';
    await options.wait();
  }
}

/** Short-lived IPC keeper; launched only by git-worktree-lock.ts. */
async function keepWorktreeLock(): Promise<void> {
  const { join } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const { execFile } = await import('node:child_process');
  const directory = process.argv[2]!;
  const name = `${process.pid}-${randomUUID()}.json`;
  const path = join(directory, name);
  const temporary = `${path}.tmp`;
  const wait = () => new Promise<void>(resolve => setTimeout(resolve, 25));
  let stopping = !process.connected;
  let stop!: () => void;
  const stopped = new Promise<void>(resolve => { stop = resolve; });
  let commands = Promise.resolve();
  process.on('disconnect', () => { stopping = true; stop(); });
  const send = (message: unknown) => { if (process.connected) process.send!(message, () => undefined); };
  const write = async (ticket: number, gitRunning = false) => {
    await fs.writeFile(temporary, JSON.stringify({ pid: process.pid, ticket, gitRunning }), { mode: 0o600 });
    await fs.rename(temporary, path);
  };
  const read = (entry: string) => readMutationClaim(join(directory, entry), process.platform, pid => { process.kill(pid, 0); });

  try {
    await fs.mkdir(directory, { recursive: true });
    // Lamport bakery: publish "choosing" atomically, then choose a ticket above
    // every visible ticket. Atomic rename keeps readers from observing partial JSON.
    await write(0);
    const ticket = await selectTicket(directory, name, read);
    await write(ticket);
    const waitMs = Number(process.argv[3] ?? 120_000);
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 120_000) throw new Error('invalid worktree mutation wait budget');
    const deadline = Date.now() + waitMs;
    const turn = await waitForTurn(directory, name, ticket, { read, isStopping: () => stopping, deadline, wait });
    if (turn === 'timeout') send({ kind: 'error', code: 'lock_timeout', error: 'timed out waiting for worktree mutation lock' });
    if (turn !== 'ready') return; // finally withdraws ONLY this queued claim; no mutation was admitted
    process.on('message', (message: KeeperMessage) => {
      if (stopping || message.kind !== 'git') return;
      commands = commands.then(async () => {
        await write(ticket, true);
        const result = await runGitCommand(execFile, message);
        await write(ticket);
        send({ kind: 'result', id: message.id, result });
      }).catch(error => {
        send({ kind: 'error', error: `worktree mutation command failed: ${String(error)}` });
        stopping = true;
        stop();
      });
    });
    send({ kind: 'ready' });
    await stopped;
  } catch (error) {
    send({ kind: 'error', error: `worktree mutation coordination failed: ${String(error)}` });
  } finally {
    await commands;
    await fs.unlink(path).catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    if (process.connected) process.disconnect();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await keepWorktreeLock();
