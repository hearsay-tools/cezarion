import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const source = fileURLToPath(new URL('./git-worktree.ts', import.meta.url));
const loader = resolve(dirname(source), '../../../node_modules/tsx/dist/loader.mjs');
const roots: string[] = [];
const children: ChildProcess[] = [];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
afterEach(async () => {
  // Release paused Git even when an assertion failed, before removing the fixture.
  for (const root of roots) writeFileSync(join(root, 'release'), '');
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
  }
  await pause(100);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10 });
});

async function until(check: () => boolean, label: string) {
  const end = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await pause(10);
  }
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cezar-prune-race-'));
  roots.push(root);
  await exec('git', ['init', '-q', '-b', 'main', root]);
  await exec('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
  const linked = join(root, 'linked');
  await exec('git', ['worktree', 'add', '-qb', 'linked', linked], { cwd: root });
  const c = join(root, 'pause.c');
  writeFileSync(c, `
#define _GNU_SOURCE
#include <dlfcn.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
int mkdir(const char *p, mode_t mode) {
  int (*original)(const char *, mode_t) = dlsym(RTLD_NEXT, "mkdir");
  int result = original(p, mode);
  const char *signals = getenv("RACE_SIGNALS");
  const char *suffix = ".git/worktrees/victim000000";
  size_t n = strlen(p), m = strlen(suffix);
  if (result == 0 && signals && n >= m && strcmp(p + n - m, suffix) == 0) {
    char marker[4096]; snprintf(marker, sizeof marker, "%s/paused", signals);
    int fd = creat(marker, 0600); if (fd >= 0) close(fd);
    snprintf(marker, sizeof marker, "%s/release", signals);
    for (int i = 0; i < 20000; i++) { if (access(marker, F_OK) == 0) return result; usleep(1000); }
    _exit(91);
  }
  return result;
}
`);
  const preload = join(root, 'pause.so');
  await exec('cc', ['-shared', '-fPIC', '-Wall', '-o', preload, c, '-ldl']);
  const driver = join(root, 'driver.mjs');
  writeFileSync(driver, `
import { renameSync, writeFileSync } from 'node:fs';
import { createWorktree, removeWorktree, pruneOrphans } from ${JSON.stringify(new URL('./git-worktree.ts', import.meta.url).href)};
const [root, operation, result, target, fresh] = process.argv.slice(2);
// The parent treats result existence as completion; publish only the complete JSON.
const publish = value => {
  const pending = result + '.tmp';
  writeFileSync(pending, JSON.stringify(value));
  renameSync(pending, result);
};
writeFileSync(result + '.started', '');
try {
  let value;
  if (operation === 'create') value = await createWorktree(root, target, 'main', { freshOnly: fresh === 'true' });
  else if (operation === 'remove') value = await removeWorktree(root, target);
  else value = await pruneOrphans(root, new Set(['victim000000']));
  publish({ ok: true, value });
} catch (error) { publish({ ok: false, error: String(error) }); }
`);
  function start(cwd: string, operation: string, name: string, target: string, fresh = false) {
    const result = join(root, name + '.json');
    const child = spawn(process.execPath, ['--import', loader, driver, cwd, operation, result, target, String(fresh)], {
      env: { ...process.env, LD_PRELOAD: preload, RACE_SIGNALS: root }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stderr = '';
    child.stderr!.on('data', data => { stderr += String(data); });
    return { child, result, stderr: () => stderr };
  }
  return { root, linked, start };
}

// This probes actual libc/Git interleaving on Linux; other platforms retain the
// ordinary worktree/recovery suite. No fake Git failure or metadata deletion.
describe.skipIf(process.platform !== 'linux')('worktree registration vs prune (#502)', () => {
  it.each([
    ['create', false, false], ['remove', false, false], ['orphans', false, false],
    ['create', true, false], ['create', false, true],
  ] as const)('protects add from %s (fresh=%s, reattach=%s) across processes/common-dir aliases', async (operation, fresh, reattach) => {
    const { root, linked, start } = await fixture();
    if (reattach) {
      const path = join(root, '.ai/cezar/worktrees/victim000000');
      await exec('git', ['worktree', 'add', '-b', 'cez/victim00', path, 'main'], { cwd: root });
      rmSync(path, { recursive: true }); // Leave stale metadata and the branch.
    }
    const victim = start(root, 'create', 'victim', 'victim000000', fresh);
    await until(() => existsSync(join(root, 'paused')), 'Git paused after admin mkdir');
    const peer = start(linked, operation, 'peer', operation === 'create' ? 'peer00000000' : join(root, 'absent'));
    await until(() => existsSync(peer.result + '.started'), 'peer entered helper');
    // Wait for the uncoordinated peer to finish, or for the coordinated waiter to
    // remain blocked. The held add is released explicitly, never by a Git timeout.
    await Promise.race([until(() => existsSync(peer.result), 'peer completed'), pause(1000)]);
    const preserved = existsSync(join(root, '.git/worktrees/victim000000'));
    writeFileSync(join(root, 'release'), '');
    await until(() => existsSync(victim.result) && existsSync(peer.result), 'both operations completed');
    expect({ preserved, victim: JSON.parse(readFileSync(victim.result, 'utf8')), peer: JSON.parse(readFileSync(peer.result, 'utf8')) }).toMatchObject({
      preserved: true, victim: { ok: true }, peer: { ok: true },
    });
    const listed = await exec('git', ['worktree', 'list', '--porcelain'], { cwd: linked });
    expect(listed.stdout).toContain('branch refs/heads/cez/victim00');
  }, 25_000);

  it('keeps an active Git child protected when the keeper itself dies', async () => {
    const { root, linked, start } = await fixture();
    const victim = start(root, 'create', 'victim', 'victim000000');
    await until(() => existsSync(join(root, 'paused')), 'Git paused');
    const directory = join(root, '.git/cezar-worktree-mutations');
    const claimFile = readdirSync(directory).find(name => name.endsWith('.json'))!;
    const claim = JSON.parse(readFileSync(join(directory, claimFile), 'utf8')) as { pid: number };
    process.kill(claim.pid, 'SIGKILL');
    await until(() => existsSync(victim.result), 'caller observed keeper failure');
    const peer = start(linked, 'create', 'peer', 'peer00000000');
    await until(() => existsSync(peer.result + '.started'), 'peer entered helper');
    await pause(1000);
    const preserved = existsSync(join(root, '.git/worktrees/victim000000'));
    const waited = !existsSync(peer.result);
    writeFileSync(join(root, 'release'), '');
    await until(() => existsSync(peer.result), 'peer recovered after surviving Git exited');
    expect({ preserved, waited }).toEqual({ preserved: true, waited: true });
    expect(JSON.parse(readFileSync(peer.result, 'utf8'))).toMatchObject({ ok: true });
  }, 25_000);

  it('keeps Git protected after its calling Cezar process dies, then releases for restart adoption', async () => {
    const { root, linked, start } = await fixture();
    const victim = start(root, 'create', 'victim', 'victim000000');
    await until(() => existsSync(join(root, 'paused')), 'Git paused');
    victim.child.kill('SIGKILL');
    await new Promise<void>(resolve => victim.child.once('exit', () => resolve()));
    const peer = start(linked, 'create', 'peer', 'peer00000000');
    await until(() => existsSync(peer.result + '.started'), 'peer entered helper');
    await pause(1000);
    expect(existsSync(join(root, '.git/worktrees/victim000000'))).toBe(true);
    expect(existsSync(peer.result)).toBe(false);
    writeFileSync(join(root, 'release'), '');
    await until(() => existsSync(peer.result), 'peer completed after orphaned Git exited');
    expect(JSON.parse(readFileSync(peer.result, 'utf8'))).toMatchObject({ ok: true });
    const adopted = start(root, 'create', 'adopted', 'victim000000');
    await until(() => existsSync(adopted.result), 'restart adopted checkout');
    expect(JSON.parse(readFileSync(adopted.result, 'utf8'))).toMatchObject({ ok: true });
    expect((await exec('git', ['status', '--porcelain'], { cwd: join(root, '.ai/cezar/worktrees/victim000000') })).stdout).toBe('');
  }, 25_000);
});
