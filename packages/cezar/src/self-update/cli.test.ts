import { productIdentity } from '../home/identity.ts';
import { Home } from '../home/home.ts';
import { useTestHome } from '../home/test-home.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSelfUpdateCommand } from './cli.ts';
import { writeLaunchers } from './launcher.ts';
import { activate, activeId, versionEntry, writeManifest } from './layout.ts';
import { RegistryCache } from './registry.ts';
import { SelfUpdateService } from './service.ts';

describe('managed install instructions', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cezar-cli-instructions-')); useTestHome(home ? Home.sandbox(home) : undefined); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
  it.each([true, false])('prints the actual home and installed launcher (on PATH: %s)', async onPath => {
    vi.stubEnv('PATH', onPath ? testHome().bin : '');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const service = new SelfUpdateService({ home: testHome(), pkgName: '@wjarka/cezarion', version: '0.16.0', entry: '/fixture/dist/index.js', restart: () => {} });
    vi.spyOn(service, 'installSelf').mockImplementation(async () => {
      writeLaunchers({}, testHome());
      return { id: '0.16.0+local', entry: '/fixture/dist/index.js' };
    });
    expect(await runSelfUpdateCommand('install', [], { home: testHome(), service, modifyPath: false })).toBe(0);
    const text = log.mock.calls.map(call => call.join(' ')).join('\n');
    expect(text).toContain('managed layout under ' + testHome().root);
    expect(text).toMatch(new RegExp('run(?:[: ]| \\x60)+' + (productIdentity().npmAlias ?? productIdentity().command)));
    expect(text).not.toMatch(/run(?:[: ]| \x60)+cezar\b|~\/\.cez\b/);
    expect(existsSync(join(testHome().bin, process.platform === 'win32' ? 'cezarion.cmd' : 'cezarion'))).toBe(true);
  });
});

describe('managed version selection', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cezar-cli-select-')); useTestHome(home ? Home.sandbox(home) : undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
  const install = (id: string, version: string, source: 'local' | 'link' | 'registry', installedAt: string) => {
    const entry = versionEntry(id, undefined, testHome());
    mkdirSync(dirname(entry), { recursive: true }); writeFileSync(entry, '// fixture');
    writeManifest(id, { version, source, installedAt }, undefined, testHome());
    return entry;
  };
  const service = (entry: string, version: string) => new SelfUpdateService({ home: testHome(),
    pkgName: '@wjarka/cezarion', entry, version, restart: () => {},
    registry: new RegistryCache('@wjarka/cezarion', async () => Response.json({
      'dist-tags': { latest: '0.12.0' }, versions: { '0.12.0': {} },
    })),
  });

  it.each(['0.12.0', '0.13.0'])('returns from linked version %s to the stable registry install', async version => {
    install('0.12.0', '0.12.0', 'registry', '2026-10-01');
    const linked = version + '+main';
    const entry = install(linked, version, 'link', '2026-10-02'); activate(linked, undefined, testHome());
    expect(await runSelfUpdateCommand('update', [], { home: testHome(), service: service(entry, version), channel: 'stable', modifyPath: false })).toBe(0);
    expect(activeId(undefined, testHome())).toBe('0.12.0');
  });

  it.each(['local', 'link'] as const)('prefers an exact registry ID over a newer %s install of the same version', async source => {
    const entry = install('0.12.0', '0.12.0', 'registry', '2026-10-01');
    const other = '0.12.0+' + source;
    install(other, '0.12.0', source, '2026-10-02'); activate(other, undefined, testHome());
    const opts = { home: testHome(), service: service(entry, '0.12.0'), modifyPath: false };
    expect(await runSelfUpdateCommand('use', ['0.12.0'], opts)).toBe(0);
    expect(activeId(undefined, testHome())).toBe('0.12.0');
    expect(await runSelfUpdateCommand('use', [other], opts)).toBe(0);
    expect(activeId(undefined, testHome())).toBe(other);
  });

  it('lists managed versions and registry tags without a registry request', async () => {
    const entry = install('0.12.0', '0.12.0', 'registry', '2026-10-01');
    activate('0.12.0', undefined, testHome());
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      'dist-tags': { latest: '0.13.0', nightly: '0.14.0-nightly.1' }, versions: { '0.13.0': {} },
    }));
    expect(await runSelfUpdateCommand('versions', [], { home: testHome(), service: service(entry, '0.12.0'), modifyPath: false })).toBe(0);
    expect(fetch.mock.calls[0]?.[0]).toBe(`https://registry.npmjs.org/${productIdentity().npmPackage.replace('/', '%2F')}`);
    const text = vi.mocked(console.log).mock.calls.map(call => call.join(' ')).join('\n');
    expect(text).toContain('* 0.12.0');
    expect(text).toContain('stable 0.13.0');
    expect(text).toContain('nightly 0.14.0-nightly.1');
  });

  it('keeps version-only fallback when no exact ID exists', async () => {
    const id = '0.12.0+local'; const entry = install(id, '0.12.0', 'local', '2026-10-01');
    expect(await runSelfUpdateCommand('use', ['0.12.0'], { home: testHome(), service: service(entry, '0.12.0'), modifyPath: false })).toBe(0);
    expect(activeId(undefined, testHome())).toBe(id);
  });
});
