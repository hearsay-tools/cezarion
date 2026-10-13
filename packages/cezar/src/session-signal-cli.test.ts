import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from './runs/store.ts';

/**
 * cezar's own SIGINT and SIGTERM reach the agents (hearsay-tools/cezarion#890), through the real CLI.
 *
 * Agent sessions lead their own process groups, so the terminal's Ctrl-C no longer reaches them
 * through cezar's foreground group. `serve` forwards the signal as it exits, after its store has
 * closed, so the run stays `running` for restart recovery; `cez run` forwards it and still ends
 * by it. cezar is started in its own group, as a shell starts a foreground job.
 *
 * The agent outlives its stdin: the bundled mock exits when cezar's exit closes its stdin, which
 * would pass these tests with no forwarding at all. Every probe (`--help`, auth) still goes to
 * the mock; only a session stalls.
 */

const CLI = fileURLToPath(new URL('./index.ts', import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url));
const MOCK_CLAUDE = fileURLToPath(new URL('../scripts/mock-claude.mjs', import.meta.url));
const STALLING_AGENT = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (!args.includes('--input-format')) process.exit(spawnSync(process.execPath, [${JSON.stringify(MOCK_CLAUDE)}, ...args], { stdio: 'inherit' }).status ?? 1);
writeFileSync('watchdog.pid', String(process.pid));
setInterval(() => {}, 1000);
`;

let root: string;
let cez: ChildProcess | undefined;
const agents: number[] = [];

const env = () => {
  const vars: NodeJS.ProcessEnv = { ...process.env, CEZ_DRY_RUN: '1', CEZ_HOME: join(root, 'home'), CEZ_NO_BANNER: '1',
    CEZ_CLAUDE_BIN: join(root, 'stalling-agent.mjs') };
  delete vars.CEZ_AUTOMATIONS;
  return vars;
};

/** A zombie has exited; only its reaper's wait remains. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== 'linux') return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 1).trim()[0] !== 'Z';
  } catch { return false; }
}

/** The agent, once it stalls in its task worktree. */
async function agentPid(): Promise<number> {
  return vi.waitFor(() => {
    const worktrees = join(root, '.ai/cezar/worktrees');
    const file = readdirSync(worktrees).map(id => join(worktrees, id, 'watchdog.pid')).find(existsSync);
    expect(file).toBeDefined();
    const pid = Number(readFileSync(file!, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    agents.push(pid);
    return pid;
  }, { timeout: 30_000, interval: 100 });
}

async function serve(): Promise<string> {
  cez = spawn(process.execPath, ['--import', 'tsx', CLI, 'serve', '--repo', root, '--port', '0', '--no-open'], {
    cwd: PACKAGE_DIR, env: env(), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let stderr = '';
  cez.stderr!.on('data', (chunk) => { stderr += chunk; });
  for await (const line of createInterface({ input: cez.stdout! })) {
    const url = /cockpit → (http:\/\/\S+)/.exec(line)?.[1];
    if (url) { cez.stdout!.resume(); return url; }
  }
  throw new Error(`serve exited before listening: ${stderr}`);
}

async function stalledRun(url: string): Promise<string> {
  const response = await fetch(`${url}/api/v1/runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 'mock:no-progress', workflow: 'quick-task', runner: 'claude' }),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  return ((await response.json()) as { id: string }).id;
}

/**
 * Runs argv on a pseudo-terminal as its session leader, then closes the master when `hangup`
 * appears: the kernel hangs up the foreground group, as closing a terminal window does. Prints
 * the child's exit status ("signal N" or "code N") once it ends.
 */
const PTY_HOST = `
import os, pty, sys, time, signal
hangup = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
os.set_blocking(fd, False)
while not os.path.exists(hangup):
    try: os.read(fd, 65536)
    except (BlockingIOError, OSError): time.sleep(0.05)
os.close(fd)
_, status = os.waitpid(pid, 0)
print('signal %d' % os.WTERMSIG(status) if os.WIFSIGNALED(status) else 'code %d' % os.WEXITSTATUS(status), flush=True)
`;

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  probe.close();
  await once(probe, 'close');
  return port;
}

function onPty(args: string[]): { hangUp: () => void; ended: Promise<string> } {
  const hangup = join(root, 'hangup');
  const host = spawn('python3', ['-I', '-c', PTY_HOST, hangup, process.execPath, '--import', 'tsx', CLI, ...args], {
    cwd: PACKAGE_DIR, env: env(), stdio: ['ignore', 'pipe', 'inherit'],
  });
  cez = host;
  let out = '';
  host.stdout!.on('data', (chunk) => { out += chunk; });
  const ended = once(host, 'exit').then(() => out.trim().split('\n').at(-1) ?? '');
  return { hangUp: () => writeFileSync(hangup, ''), ended };
}

describe.skipIf(process.platform === 'win32')('cezar forwards SIGINT and SIGTERM to agent sessions (hearsay-tools/cezarion#890)', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-session-signal-'));
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    writeFileSync(join(root, 'stalling-agent.mjs'), STALLING_AGENT);
    chmodSync(join(root, 'stalling-agent.mjs'), 0o755);
  });

  afterEach(() => {
    if (cez?.pid) try { process.kill(-cez.pid, 'SIGKILL'); } catch { /* gone */ }
    cez = undefined;
    for (const pid of agents.splice(0)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    rmSync(root, { recursive: true, force: true });
  });

  it('Ctrl-C on cez serve stops the agent and leaves the run for recovery', async () => {
    const id = await stalledRun(await serve());
    const agent = await agentPid();
    const exited = once(cez!, 'exit');
    process.kill(-cez!.pid!, 'SIGINT'); // the terminal signals the foreground job's group
    await exited;
    await vi.waitFor(() => expect(alive(agent)).toBe(false), { timeout: 5_000 });
    // keepLive: read the run as serve left it, before any reader reconciles a live run as failed.
    const store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    try { expect(store.getRun(id)?.status).toBe('running'); } finally { store.close(); }
  }, 60_000);

  it('SIGTERM to cez serve alone stops the agent', async () => {
    await stalledRun(await serve());
    const agent = await agentPid();
    const exited = once(cez!, 'exit');
    process.kill(cez!.pid!, 'SIGTERM'); // `kill <pid>`: no terminal involved
    await exited;
    await vi.waitFor(() => expect(alive(agent)).toBe(false), { timeout: 5_000 });
  }, 60_000);

  it('Ctrl-C on cez run stops the agent and still ends cez by SIGINT', async () => {
    cez = spawn(process.execPath, ['--import', 'tsx', CLI, 'run', 'mock:no-progress', '--repo', root], {
      cwd: PACKAGE_DIR, env: env(), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    cez.stdout!.resume(); cez.stderr!.resume();
    const agent = await agentPid();
    const exited = once(cez, 'exit');
    process.kill(-cez.pid!, 'SIGINT');
    const [, signal] = await exited;
    expect(signal).toBe('SIGINT');
    await vi.waitFor(() => expect(alive(agent)).toBe(false), { timeout: 5_000 });
  }, 60_000);

  describe('SIGHUP when the terminal closes (hearsay-tools/cezarion#915)', () => {
    const hasPython = (() => { try { execFileSync('python3', ['-c', 'import pty']); return true; } catch { return false; } })();

    it.skipIf(!hasPython)('closing the terminal of cez serve stops the agent and leaves the run for recovery', async () => {
      const port = await freePort();
      const url = `http://127.0.0.1:${port}`;
      const terminal = onPty(['serve', '--repo', root, '--port', String(port), '--no-open']);
      await vi.waitFor(async () => expect((await fetch(`${url}/api/v1/health`)).ok).toBe(true), { timeout: 30_000, interval: 200 });
      const id = await stalledRun(url);
      const agent = await agentPid();
      terminal.hangUp();
      await terminal.ended;
      await vi.waitFor(() => expect(alive(agent)).toBe(false), { timeout: 5_000 });
      const store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
      try { expect(store.getRun(id)?.status).toBe('running'); } finally { store.close(); }
    }, 60_000);

    it.skipIf(!hasPython)('closing the terminal of cez run stops the agent and ends cez by SIGHUP', async () => {
      const terminal = onPty(['run', 'mock:no-progress', '--repo', root]);
      const agent = await agentPid();
      terminal.hangUp();
      expect(await terminal.ended).toBe('signal 1');
      await vi.waitFor(() => expect(alive(agent)).toBe(false), { timeout: 5_000 });
    }, 60_000);

    it('nohup cez serve survives a hangup and its agent keeps running', async () => {
      cez = spawn('nohup', [process.execPath, '--import', 'tsx', CLI, 'serve', '--repo', root, '--port', '0', '--no-open'], {
        cwd: PACKAGE_DIR, env: env(), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      });
      cez.stderr!.resume();
      let url = '';
      for await (const line of createInterface({ input: cez.stdout! })) {
        url = /cockpit → (http:\/\/\S+)/.exec(line)?.[1] ?? '';
        if (url) break;
      }
      cez.stdout!.resume();
      await stalledRun(url);
      const agent = await agentPid();
      process.kill(cez.pid!, 'SIGHUP');
      await new Promise(resolve => setTimeout(resolve, 1_000));
      expect(alive(cez.pid!)).toBe(true);
      expect(alive(agent)).toBe(true);
    }, 60_000);
  });
});
