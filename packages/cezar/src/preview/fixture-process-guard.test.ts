import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { fixtureProcessGuard } from './preview.testkit.ts';

/**
 * The leak guard and the fixture's lifetime cap are what stop `fake-dev-server.mjs` from piling up
 * on the host (hearsay-tools/cezarion#1880): the guard fails the test that leaves a process, and the
 * cap ends a process whose test run was killed before its teardown.
 */

const FIXTURE = fileURLToPath(new URL('./__fixtures__/fake-dev-server.mjs', import.meta.url));

const strays: ChildProcess[] = [];

afterEach(() => {
  for (const stray of strays.splice(0)) {
    try { process.kill(-stray.pid!, 'SIGKILL'); } catch { /* not a group leader, or gone */ }
    stray.kill('SIGKILL');
  }
});

function launch(args: string[], opts: { detached?: boolean } = {}): ChildProcess {
  const child = spawn(process.execPath, [FIXTURE, '--port', '0', ...args], { detached: opts.detached ?? false, stdio: 'ignore' });
  strays.push(child);
  return child;
}

const exited = (child: ChildProcess) => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
  else child.once('exit', (code, signal) => resolve({ code, signal }));
});

describe('fixtureProcessGuard', () => {
  it('passes when nothing carries its tag', async () => {
    await fixtureProcessGuard().assertNoneLeft();
  });

  it('kills a tagged fixture left running and fails, naming its pid', async () => {
    const guard = fixtureProcessGuard();
    const child = launch(['--delay', '600000', ...guard.args]);
    await expect(guard.assertNoneLeft()).rejects.toThrow(new RegExp(`outlived the test.*\\n\\s+${child.pid} .*fake-dev-server\\.mjs`));
    expect((await exited(child)).signal).toBe('SIGKILL');
  });

  it('sees a launch through a shell and its SIGTERM-ignoring holder, not only the process it started', async () => {
    const guard = fixtureProcessGuard();
    const command = [process.execPath, FIXTURE, '--port', '0', '--fork', '--ignore-term', ...guard.args].map(part => JSON.stringify(part)).join(' ');
    const shell = spawn('/bin/sh', ['-c', command], { detached: true, stdio: 'ignore' });
    strays.push(shell);
    // Whether the shell stays above the leader differs by platform, so the holder is the one to find.
    await expect(guard.assertNoneLeft()).rejects.toThrow(/outlived the test[^]*fake-dev-server\.mjs --holder /);
    await exited(shell);
  });

  it("leaves another guard's fixtures alone", async () => {
    const mine = fixtureProcessGuard();
    const theirs = fixtureProcessGuard();
    const child = launch(['--delay', '600000', ...theirs.args]);
    await mine.assertNoneLeft();
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    await expect(theirs.assertNoneLeft()).rejects.toThrow(/outlived the test/);
  });
});

describe('fake-dev-server --lifetime', () => {
  it('ends the process by itself, so a killed test run strands it for minutes at most', async () => {
    const child = launch(['--delay', '600000', '--lifetime', '300']);
    expect(await exited(child)).toEqual({ code: 0, signal: null });
  });

  it('ends a --fork leader and its SIGTERM-ignoring holder', async () => {
    const guard = fixtureProcessGuard();
    const leader = launch(['--fork', '--ignore-term', '--lifetime', '300', ...guard.args], { detached: true });
    expect(await exited(leader)).toEqual({ code: 0, signal: null });
    await guard.assertNoneLeft();
  });
});
