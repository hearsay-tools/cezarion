import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSelfUpdateCommand } from './cli.ts';
import { SelfUpdateService } from './service.ts';

describe('managed install instructions', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cezar-cli-instructions-')); vi.stubEnv('CEZ_HOME', home); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
  it.each([true, false])('prints the actual home and installed launcher (on PATH: %s)', async onPath => {
    vi.stubEnv('PATH', onPath ? join(home, 'bin') : '');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const service = new SelfUpdateService({ pkgName: '@wjarka/cezarion', version: '0.16.0', entry: '/fixture/dist/index.js', restart: () => {} });
    vi.spyOn(service, 'installSelf').mockResolvedValue({ id: '0.16.0+local', entry: '/fixture/dist/index.js' });
    expect(await runSelfUpdateCommand('install', [], { service, modifyPath: false })).toBe(0);
    const text = log.mock.calls.map(call => call.join(' ')).join('\n');
    expect(text).toContain('managed layout under ' + home);
    expect(text).toMatch(/run(?:[: ]| \x60)+cezarion/);
    expect(text).not.toMatch(/run(?:[: ]| \x60)+cezar\b|~\/\.cez\b/);
    expect(existsSync(join(home, 'bin', process.platform === 'win32' ? 'cezarion.cmd' : 'cezarion'))).toBe(true);
  });
});
