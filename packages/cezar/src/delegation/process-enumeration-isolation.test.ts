import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { fixtureProcessDirectory, fixtureProcessEnumeration } from './process-enumeration.testkit.ts';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';

it('streams only tracked fixture descendants and retains an observed orphan', () => {
  let parent = '100';
  const read = vi.fn(() => ['100', '101', '999']) as unknown as typeof fs.readdirSync;
  const stat = vi.fn((path: string) => {
    const pid = path.split('/')[2];
    const ppid = pid === '101' ? parent : '1';
    return `${pid} (fixture) S ${ppid} ${Array(17).fill('0').join(' ')} ${pid}`;
  }) as unknown as typeof fs.readFileSync;
  const enumerate = fixtureProcessEnumeration(read, stat, 100);
  const fallback = vi.fn() as unknown as typeof fs.opendirSync;
  const open = fixtureProcessDirectory(enumerate, fallback);
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('unexpected signal'); });
  try {
    const names = () => {
      const dir = open('/proc');
      const result: string[] = [];
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) result.push(entry.name);
      dir.closeSync();
      return result;
    };
    expect(names()).toEqual(['100', '101']);
    parent = '1';
    expect(names()).toEqual(['100', '101']);
    expect(fallback).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  } finally { kill.mockRestore(); }
});

it('captures the original directory reader before installing the spy and restores it', () => {
  const original = fs.opendirSync;
  const dir = { readSync: () => null, closeSync: () => {} } as unknown as fs.Dir;
  const fallback = vi.fn(() => dir);
  const scoped = fixtureProcessDirectory((() => []) as unknown as typeof fs.readdirSync, fallback as typeof fs.opendirSync);
  const base = vi.spyOn(fs, 'opendirSync').mockImplementation(scoped);
  try {
    expect(fs.opendirSync('/proc/101/fd')).toBe(dir);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith('/proc/101/fd', undefined);
  } finally { base.mockRestore(); }
  expect(fs.opendirSync).toBe(original);
});

it('installs and restores the actual scope hook for a non-proc directory', () => {
  const path = fs.mkdtempSync(join(tmpdir(), 'cez-directory-scope-'));
  const original = fs.opendirSync;
  const restore = scopeFixtureProcesses();
  try {
    const directory = fs.opendirSync(path);
    expect(directory.readSync()).toBeNull();
    directory.closeSync();
  } finally { restore(); fs.rmSync(path, { recursive: true }); }
  expect(fs.opendirSync).toBe(original);
});
