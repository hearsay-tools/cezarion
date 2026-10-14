import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { killFromPidFile, parsePids, readPid, requirePid, writePidSource, type Kill } from './pid-file.testkit.ts';

// hearsay-tools/cezarion#953: `process.kill(Number(''))` is `process.kill(0)`, which signals
// the caller's whole process group: Vitest, or the Squeal daemon hosting it.
describe('pid files (hearsay-tools/cezarion#953)', () => {
  let dir: string;
  let file: string;
  const calls: Array<[number, unknown]> = [];
  const kill: Kill = (pid, signal) => { calls.push([pid, signal]); return true; };
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cez-pid-file-')); file = join(dir, 'pid'); calls.length = 0; });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each([
    ['empty', ''],
    ['a bare newline', '\n'],
    ['garbage', 'not a pid'],
    ['zero', '0'],
    ['one', '1'],
    ['a negative pid', '-4242'],
    ['a half-written line', '42x'],
    ['a fraction', '42.5'],
    ['an exponent', '1e3'],
    ['an unsafe integer', '99999999999999999999'],
  ])('never signals %s, and reads no pid from it', (_name, text) => {
    writeFileSync(file, text);
    expect(killFromPidFile(file, 'SIGKILL', kill)).toEqual([]);
    expect(calls).toEqual([]);
    expect(readPid(file)).toBeUndefined();
    expect(() => requirePid(file)).toThrow(/holds no complete pid/);
  });

  it('signals each complete pid and skips the rest', () => {
    writeFileSync(file, '4242\n0\n\n1\n 4343 \r\ngarbage\n');
    expect(killFromPidFile(file, 'SIGTERM', kill)).toEqual([4242, 4343]);
    expect(calls).toEqual([[4242, 'SIGTERM'], [4343, 'SIGTERM']]);
    expect(parsePids('4242\n0\n1\n')).toEqual([4242]);
  });

  it('treats a missing file as no pids, and a single pid as the pid', () => {
    expect(killFromPidFile(file, 'SIGKILL', kill)).toEqual([]);
    expect(readPid(file)).toBeUndefined();
    expect(() => requirePid(file)).toThrow(/<ENOENT>/);
    writeFileSync(file, '4242');
    expect(readPid(file)).toBe(4242);
    expect(requirePid(file)).toBe(4242);
    writeFileSync(file, '4242\n4343\n');
    expect(readPid(file)).toBeUndefined();
  });

  it('ignores a process that is gone or not ours, and throws anything else', () => {
    writeFileSync(file, '4242\n4343\n');
    const failing = (code: string): Kill => () => { throw Object.assign(new Error(code), { code }); };
    expect(killFromPidFile(file, 'SIGKILL', failing('ESRCH'))).toEqual([]);
    expect(killFromPidFile(file, 'SIGKILL', failing('EPERM'))).toEqual([]);
    expect(() => killFromPidFile(file, 'SIGKILL', failing('EINVAL'))).toThrow('EINVAL');
  });

  it('fakes publish complete pids', () => {
    const run = (source: string) => execFileSync(process.execPath, ['-e', source], { cwd: dir });
    run(writePidSource(file));
    const writer = readPid(file);
    expect(writer).toBeGreaterThan(1);
    run(writePidSource(file));
    expect(readPid(file)).not.toBe(writer);
    const appended = join(dir, 'pids');
    for (let n = 0; n < 3; n++) run(writePidSource(appended, { append: true }));
    expect(parsePids(readFileSync(appended, 'utf8'))).toHaveLength(3);
    expect(readdirSync(dir).sort()).toEqual(['pid', 'pids']);
  });

  // A pid read from a file must go through this module. The scan covers every test source,
  // including the packaged-CLI and node:test suites.
  it('no test signals a pid parsed straight out of a file', () => {
    const root = join(import.meta.dirname, '..');
    const sources = ['src', 'test'].flatMap(top => readdirSync(join(root, top), { recursive: true, encoding: 'utf8' })
      .filter(path => (top === 'test' ? /\.ts$/ : /\.(test|testkit)\.ts$/).test(path) && !/pid-file\.testkit(\.test)?\.ts$/.test(path))
      .map(path => join(root, top, path)));
    const offenders = sources.flatMap(path => readFileSync(path, 'utf8').split('\n')
      .flatMap((line, index) => /kill\(\s*-?\s*Number\(/.test(line) ? [`${relative(root, path)}:${index + 1}`] : []));
    expect(offenders).toEqual([]);
  });
});
