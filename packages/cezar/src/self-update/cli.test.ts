import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSelfUpdateCommand } from './cli.ts';
import { activate, activeId, versionEntry, writeManifest } from './layout.ts';
import { RegistryCache } from './registry.ts';
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

describe('managed version selection', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cezar-cli-select-')); vi.stubEnv('CEZ_HOME', home);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
  const install = (id: string, version: string, source: 'local' | 'link' | 'registry', installedAt: string) => {
    const entry = versionEntry(id);
    mkdirSync(dirname(entry), { recursive: true }); writeFileSync(entry, '// fixture');
    writeManifest(id, { version, source, installedAt });
    return entry;
  };
  const service = (entry: string, version: string) => new SelfUpdateService({
    pkgName: '@wjarka/cezarion', entry, version, restart: () => {},
    registry: new RegistryCache('@wjarka/cezarion', async () => Response.json({
      'dist-tags': { latest: '0.12.0' }, versions: { '0.12.0': {} },
    })),
  });

  it.each(['0.12.0', '0.13.0'])('returns from linked version %s to the stable registry install', async version => {
    install('0.12.0', '0.12.0', 'registry', '2026-10-01');
    const linked = version + '+main';
    const entry = install(linked, version, 'link', '2026-10-02'); activate(linked);
    expect(await runSelfUpdateCommand('update', [], { service: service(entry, version), channel: 'stable', modifyPath: false })).toBe(0);
    expect(activeId()).toBe('0.12.0');
  });

  it.each(['local', 'link'] as const)('prefers an exact registry ID over a newer %s install of the same version', async source => {
    const entry = install('0.12.0', '0.12.0', 'registry', '2026-10-01');
    const other = '0.12.0+' + source;
    install(other, '0.12.0', source, '2026-10-02'); activate(other);
    const opts = { service: service(entry, '0.12.0'), modifyPath: false };
    expect(await runSelfUpdateCommand('use', ['0.12.0'], opts)).toBe(0);
    expect(activeId()).toBe('0.12.0');
    expect(await runSelfUpdateCommand('use', [other], opts)).toBe(0);
    expect(activeId()).toBe(other);
  });

  it('keeps version-only fallback when no exact ID exists', async () => {
    const id = '0.12.0+local'; const entry = install(id, '0.12.0', 'local', '2026-10-01');
    expect(await runSelfUpdateCommand('use', ['0.12.0'], { service: service(entry, '0.12.0'), modifyPath: false })).toBe(0);
    expect(activeId()).toBe(id);
  });
});
