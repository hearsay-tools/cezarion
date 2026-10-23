import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { confineExitFile, readExitCode } from './exit-file.ts';

// hearsay-tools/cezarion#1446: the exit file is the one thing Cezar reads for a process wait. It
// must sit in the worktree or the run's temp directory, and only an integer leaves it.
let root: string, worktree: string, tmpDir: string, outside: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-exit-file-')));
  worktree = join(root, 'worktree'); tmpDir = join(root, 'tmp'); outside = join(root, 'outside');
  for (const dir of [worktree, tmpDir, outside]) mkdirSync(dir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('confineExitFile', () => {
  it('accepts a relative path under the worktree and an absolute one under the temp directory', () => {
    expect(confineExitFile('build.exit', { worktree, tmpDir })).toEqual({ ok: true, path: join(worktree, 'build.exit') });
    expect(confineExitFile(join(tmpDir, 'b', 'build.exit'), { worktree, tmpDir })).toEqual({ ok: true, path: join(tmpDir, 'b', 'build.exit') });
  });

  it('refuses a path that leaves both roots, and names the roots', () => {
    expect(confineExitFile('../outside/x.exit', { worktree, tmpDir })).toEqual({ ok: false, allowed: [worktree, tmpDir] });
    expect(confineExitFile(join(tmpDir, 'x.exit'), { worktree })).toEqual({ ok: false, allowed: [worktree] });
  });

  it('refuses a symlinked directory or file that points outside', () => {
    symlinkSync(outside, join(worktree, 'link'));
    expect(confineExitFile('link/x.exit', { worktree, tmpDir }).ok).toBe(false);
    writeFileSync(join(outside, 'secret'), '0\n');
    symlinkSync(join(outside, 'secret'), join(worktree, 'secret.exit'));
    expect(confineExitFile('secret.exit', { worktree, tmpDir }).ok).toBe(false);
  });
});

describe('readExitCode', () => {
  const at = (name: string, body: string | Buffer) => { const path = join(tmpDir, name); writeFileSync(path, body); return path; };

  it('reads an integer first line and nothing else', () => {
    expect(readExitCode(join(tmpDir, 'none.exit'), { worktree, tmpDir })).toEqual({ present: false });
    expect(readExitCode(at('ok.exit', '0\n'), { worktree, tmpDir })).toEqual({ present: true, exitCode: 0 });
    expect(readExitCode(at('kill.exit', '137'), { worktree, tmpDir })).toEqual({ present: true, exitCode: 137 });
    expect(readExitCode(at('neg.exit', ' -1 \nmore'), { worktree, tmpDir })).toEqual({ present: true, exitCode: -1 });
  });

  it('reports a file that holds no exit code as present without one', () => {
    expect(readExitCode(at('text.exit', 'hello\n'), { worktree, tmpDir })).toEqual({ present: true });
    expect(readExitCode(at('big.exit', '9'.repeat(10 * 1024 * 1024)), { worktree, tmpDir })).toEqual({ present: true });
    expect(readExitCode(at('wide.exit', '99999999999\n'), { worktree, tmpDir })).toEqual({ present: true });
    expect(readExitCode(at('empty.exit', ''), { worktree, tmpDir })).toEqual({ present: true });
  });

  // A FIFO with no writer blocks a plain open, and the reader runs on the server's event loop.
  // The read runs in a child process so a regression fails the test instead of hanging the runner.
  it('reports a FIFO as present without a code, without blocking', () => {
    const fifo = join(tmpDir, 'fifo.exit');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    const module = fileURLToPath(new URL('./exit-file.ts', import.meta.url));
    const script = `import { readExitCode } from ${JSON.stringify(module)};
      console.log(JSON.stringify(readExitCode(${JSON.stringify(fifo)}, ${JSON.stringify({ worktree, tmpDir })})));`;
    // bound: a blocked open never returns; 20 s leaves room for a loaded host to start node.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
    expect(child.error).toBeUndefined();
    expect(JSON.parse(child.stdout)).toEqual({ present: true });
  });

  it('throws when the file was swapped for a symlink that leaves the roots', () => {
    writeFileSync(join(outside, 'secret'), '0\n');
    symlinkSync(join(outside, 'secret'), join(tmpDir, 'swapped.exit'));
    expect(() => readExitCode(join(tmpDir, 'swapped.exit'), { worktree, tmpDir })).toThrow(/outside/);
  });
});
