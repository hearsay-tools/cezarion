import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHECK_KILL_GRACE_MS, CHECK_TERMINATION_CONFIRM_MS, runGroupedCommand } from './grouped-command.ts';

/**
 * The process-group runner check steps and worktree setup (#917) share. Check-step Stop
 * semantics stay pinned in `check-stop-kill.test.ts`; this file pins the runner's own contract,
 * including what setup adds: a timeout and tail-first output.
 */
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-grouped-'));
  dirs.push(dir);
  return dir;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function waitForFile(path: string, ms = 10_000): Promise<number> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(path) && readFileSync(path, 'utf8').trim() !== '') return Number(readFileSync(path, 'utf8').trim());
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

const base = (cwd: string) => ({ cwd, env: process.env, setInterrupt: () => undefined, keep: 'head' as const, cap: 20_000 });

describe('runGroupedCommand', () => {
  it('reports exit code and combined output', async () => {
    const result = await runGroupedCommand({ ...base(scratch()), command: 'echo out; echo err >&2; exit 4' });
    expect(result.exitCode).toBe(4);
    expect(result.output).toContain('out');
    expect(result.output).toContain('err');
    expect(result.timedOut).toBe(false);
  });

  it('a timeout kills a group that ignores SIGTERM', async () => {
    const dir = scratch();
    const pidFile = join(dir, 'pid');
    const started = Date.now();
    // 2 s, not less: a 300 ms timeout fired before `bash -l` had written the pid when the
    // full suite ran at load ~120 (final gate for #917), and the test then waited for a file
    // that was never written. The pid is read after the result, from the finished command.
    const timeoutMs = 2_000;
    const result = await runGroupedCommand({
      ...base(dir),
      command: `trap '' TERM; echo $$ > ${pidFile}; while true; do sleep 0.1; done`,
      timeoutMs,
    });
    expect(result.timedOut).toBe(true);
    expect(result.output.endsWith('(timed out after 2s)')).toBe(true);
    expect(existsSync(pidFile)).toBe(true);
    expect(alive(Number(readFileSync(pidFile, 'utf8').trim()))).toBe(false);
    expect(Date.now() - started).toBeLessThan(timeoutMs + CHECK_KILL_GRACE_MS + CHECK_TERMINATION_CONFIRM_MS + 2_000);
  }, 30_000);

  it('tail mode keeps the last cap characters', async () => {
    const result = await runGroupedCommand({
      ...base(scratch()),
      command: `node -e "process.stdout.write('a'.repeat(50)+'END')"`,
      keep: 'tail',
      cap: 10,
    });
    expect(result.output).toBe(`… (earlier output truncated)\n${'a'.repeat(7)}END`);
  });

  it("head mode keeps today's truncation", async () => {
    const result = await runGroupedCommand({
      ...base(scratch()),
      command: `node -e "process.stdout.write('a'.repeat(50)+'END')"`,
      cap: 10,
    });
    expect(result.output.startsWith('aaaaaaaaaa')).toBe(true);
    expect(result.output.endsWith('… (output truncated)')).toBe(true);
  });

  it('the stop function passed to setInterrupt stops the command', async () => {
    const dir = scratch();
    const pidFile = join(dir, 'pid');
    let stop: () => void = () => undefined;
    const pending = runGroupedCommand({
      ...base(dir),
      command: `echo $$ > ${pidFile}; while true; do sleep 0.1; done`,
      setInterrupt: (fn) => { stop = fn; },
    });
    const pid = await waitForFile(pidFile);
    stop();
    const result = await pending;
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(alive(pid)).toBe(false);
  }, 20_000);

  it('reports empty output as (no output)', async () => {
    const result = await runGroupedCommand({ ...base(scratch()), command: 'true' });
    expect(result).toEqual({ exitCode: 0, output: '(no output)', timedOut: false });
  });
});
