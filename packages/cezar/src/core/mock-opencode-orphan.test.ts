import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// hearsay-tools/cezarion#1449: the mock OpenCode server leads its own session, so a test
// process that dies before its cleanup used to leave it running for days. The mock now exits
// when its stdin pipe closes, which happens when the parent dies, also by SIGKILL.
const MOCK = fileURLToPath(new URL('../../scripts/mock-opencode-serve.mjs', import.meta.url));

// The parent spawns the mock as spawnSessionLeader does (detached, default stdio pipes), opens
// a session, sends one prompt, and prints the mock's pid once the prompt is accepted.
const PARENT = `
const { spawn } = require('node:child_process');
const [mock, cwd, prompt] = process.argv.slice(1);
const child = spawn(process.execPath, [mock, 'serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd, detached: true });
child.stderr.resume();
let out = '';
child.stdout.on('data', async chunk => {
  out += chunk;
  const url = /listening on (http:\\/\\/\\S+)/.exec(out)?.[1];
  if (!url || out === null) return;
  out = null;
  const post = (path, body) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const session = await (await post('/session', {})).json();
  await post('/session/' + session.id + '/prompt_async', { parts: [{ type: 'text', text: prompt }] });
  console.log(JSON.stringify({ pid: child.pid }));
});
`;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== 'linux') return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 1).trim()[0] !== 'Z';
  } catch { return false; }
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

async function startMock(prompt: string): Promise<{ parent: ChildProcess; mock: number; cwd: string }> {
  const cwd = mkdtempSync(join(tmpdir(), 'cez-mock-opencode-orphan-'));
  const parent = spawn(process.execPath, ['-e', PARENT, MOCK, cwd, prompt], { stdio: ['ignore', 'pipe', 'inherit'] });
  let mock: number | undefined;
  cleanups.push(() => {
    if (mock !== undefined && alive(mock)) process.kill(mock, 'SIGKILL');
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
    rmSync(cwd, { recursive: true, force: true });
  });
  for await (const line of createInterface({ input: parent.stdout! })) {
    mock = (JSON.parse(line) as { pid: number }).pid;
    break;
  }
  if (mock === undefined) throw new Error('the parent exited before it reported the mock pid');
  return { parent, mock, cwd };
}

async function killParent(parent: ChildProcess): Promise<void> {
  const exited = new Promise(resolve => parent.once('exit', resolve));
  parent.kill('SIGKILL');
  await exited;
}

describe.skipIf(process.platform === 'win32')('mock OpenCode server outlives no parent (hearsay-tools/cezarion#1449)', () => {
  it('exits after its parent gets SIGKILL', async () => {
    const { parent, mock } = await startMock('mock:agent-echo hello');
    expect(alive(mock)).toBe(true);
    await killParent(parent);
    // bound: the acceptance criterion of #1449 is an exit within 5 s of the parent's death.
    await vi.waitFor(() => expect(alive(mock)).toBe(false), { timeout: 5000, interval: 50 });
  });

  it('exits after its parent gets SIGKILL in the mode that ignores SIGTERM', async () => {
    const { parent, mock, cwd } = await startMock('mock:no-progress-ignore-term');
    // The mock writes watchdog.pid in the same tick that it replaces its SIGTERM handler.
    // bound: the prompt is already accepted, so only the turn's start remains.
    await vi.waitFor(() => expect(existsSync(join(cwd, 'watchdog.pid'))).toBe(true), { timeout: 10_000, interval: 20 });
    process.kill(mock, 'SIGTERM');
    // A SIGTERM handler that exited would end the mock at once; this one is a no-op.
    // bound: proves an absence, so it needs real time; 300 ms is far above a signal's delivery.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(alive(mock)).toBe(true);
    await killParent(parent);
    // bound: the acceptance criterion of #1449; the mode's own 12 s timer is longer.
    await vi.waitFor(() => expect(alive(mock)).toBe(false), { timeout: 5000, interval: 50 });
  });
});
