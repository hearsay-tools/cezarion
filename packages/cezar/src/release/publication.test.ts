import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withPublicationPackage } from './publication.ts';

describe('publication staging', () => {
  it.each([false, true])('leaves source bytes intact after a failing pack/publish (renamed %s)', renamed => {
    const dir = mkdtempSync(join(tmpdir(), 'publication-test-'));
    const bytes = '{"name":"@wjarka/cezarion", "version":"1.2.3"}\n';
    writeFileSync(join(dir, 'package.json'), bytes);
    writeFileSync(join(dir, 'entry.js'), 'implementation');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'skip'), 'dependency');
    let staged = '';
    try {
      const manifest = { name: renamed ? '@hearsay-tools/squawk' : '@wjarka/cezarion', version: '1.2.3' };
      expect(() => withPublicationPackage(dir, manifest, cwd => {
        staged = cwd;
        expect(readFileSync(join(cwd, 'entry.js'), 'utf8')).toBe('implementation');
        if (renamed) {
          expect(cwd).not.toBe(dir);
          expect(JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))).toMatchObject(manifest);
          expect(existsSync(join(cwd, 'node_modules'))).toBe(false);
        } else {
          expect(cwd).toBe(dir);
          expect(readFileSync(join(cwd, 'package.json'), 'utf8')).toBe(bytes);
        }
        throw new Error('npm failure');
      })).toThrow('npm failure');
      expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(bytes);
      expect(existsSync(staged)).toBe(!renamed);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('retains the source gitHead outside Git so a stable release retry can verify its source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'publication-git-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
      git('init');
      git('-c', 'user.name=Release test', '-c', 'user.email=release@example.test', 'commit', '--allow-empty', '-m', 'source');
      const bytes = '{"name":"@wjarka/cezarion","version":"1.2.3"}\n';
      writeFileSync(join(dir, 'package.json'), bytes);
      const source = git('rev-parse', 'HEAD');
      const manifest = { name: '@hearsay-tools/squawk', version: '1.2.3' };
      withPublicationPackage(dir, manifest, cwd => {
        expect(JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).gitHead).toBe(source);
        expect(existsSync(join(cwd, '.git'))).toBe(false);
      });
      expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(bytes);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
