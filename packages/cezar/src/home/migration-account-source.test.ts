import * as fs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { migrationAccountSource } from './migration-account-source.ts';

vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, realpathSync: vi.fn(actual.realpathSync) };
});
afterEach(() => { vi.restoreAllMocks(); vi.mocked(fs.realpathSync).mockReset(); });

it('compares canonical sources against the canonical legacy root', () => {
  vi.mocked(fs.realpathSync).mockImplementation(path => path === '/home-alias' ? '/legacy' : '/legacy/credentials/work');
  expect(migrationAccountSource('/home-alias', '/profile-alias')).toBe('/legacy/credentials/work');
});

it('skips a missing or dangling source exactly as migration does', () => {
  vi.mocked(fs.realpathSync).mockImplementation(() => { throw Object.assign(new Error('missing source'), { code: 'ENOENT' }); });
  expect(migrationAccountSource('/legacy', '/dangling')).toBeUndefined();
});

it('propagates an unreadable source instead of guessing from its lexical path', () => {
  const error = Object.assign(new Error('unreadable source'), { code: 'EACCES' });
  vi.mocked(fs.realpathSync).mockImplementation(() => { throw error; });
  expect(() => migrationAccountSource('/legacy', '/legacy/unreadable')).toThrow(error);
});
