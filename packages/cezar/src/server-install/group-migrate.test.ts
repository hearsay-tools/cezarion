import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readInstallMarker } from '../home/install-marker.ts';
import { commitLegacyMigration } from '../home/migrate.ts';
import { Home } from '../home/home.ts';
import { prepareMigrationHome } from '../home/migration-boot.ts';
import { HomeStore } from '../home/store.ts';
import { cleanStoreRoots } from '../home/store.testkit.ts';
import { readServerMigrateJournal } from './migrate-journal.ts';
import { loadServerState } from './state.ts';
import { fakeHash } from './platforms/ubuntu-host.testkit.ts';
import { listenAddress } from './platforms/ubuntu-vps-migration.ts';
import { installInstance, serverFixture, serverMigrate, sharedHome, type ServerFixture } from './server-migrate.testkit.ts';

afterEach(cleanStoreRoots);

const userUnit = (f: ServerFixture, name: string) => join(f.host.userUnitDir, name);
const unitName = (f: ServerFixture, instance: string) =>
  loadServerState(instance, f.target).steps.autostart?.created?.artifacts.find(a => a.type === 'service')?.name;

function expectOldGroup(f: ServerFixture): void {
  expect(f.host.unit('user', 'hearsay-squawk.service')).toMatchObject({ enabled: false, active: false });
  expect(f.host.unit('system', 'hearsay-squawk-shop.service')).toMatchObject({ enabled: false, active: false });
  expect(f.host.unit('user', 'cezar.service')).toMatchObject({ enabled: true, active: true });
  expect(f.host.unit('system', 'cezar-shop.service')).toMatchObject({ enabled: true, active: true });
  expect(existsSync(userUnit(f, 'cezar.service'))).toBe(true);
  expect(existsSync(userUnit(f, 'hearsay-squawk.service'))).toBe(false);
  expect(f.host.exists('/etc/systemd/system/cezar-shop.service')).toBe(true);
  expect(f.host.exists('/etc/systemd/system/hearsay-squawk-shop.service')).toBe(false);
  expect(f.host.enabledSites()).toEqual(['cezar', 'cezar-shop']);
  expect(f.host.exists('/etc/hearsay-squawk')).toBe(false);
  expect(existsSync(join(f.target.config, 'install.json.failed'))).toBe(true);
  expect(readInstallMarker(f.target.config)).toBeUndefined();
  expect(existsSync(join(f.legacy.root, 'MOVED.json'))).toBe(false);
  expect(readServerMigrateJournal(f.target)).toBeUndefined();
}

describe('server-migrate group', () => {
  it('migrates two instances that share one home together and commits once', async () => {
    const f = sharedHome();
    const before = readFileSync(f.legacy.serverState('shop'));
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'migrated' });
    expect(f.host.unit('user', 'hearsay-squawk.service')).toMatchObject({ enabled: true, active: true });
    expect(f.host.unit('system', 'hearsay-squawk-shop.service')).toMatchObject({ enabled: true, active: true });
    expect(f.host.unit('user', 'cezar.service')).toMatchObject({ enabled: false, active: false });
    expect(existsSync(userUnit(f, 'cezar.service.migrated'))).toBe(true);
    expect(f.host.exists('/etc/systemd/system/cezar-shop.service.migrated')).toBe(true);
    expect(f.host.enabledSites()).toEqual(['hearsay-squawk', 'hearsay-squawk-shop']);
    expect(f.host.read('/etc/cezar/htpasswd-shop')).toBe(f.host.read('/etc/hearsay-squawk/htpasswd-shop'));
    expect(readInstallMarker(f.target.config)?.state).toBe('committed');
    expect(unitName(f, 'default')).toBe('hearsay-squawk.service');
    expect(unitName(f, 'shop')).toBe('hearsay-squawk-shop.service');
    expect(readFileSync(f.legacy.serverState('shop'))).toEqual(before);
    expect(existsSync(join(f.legacy.root, 'MOVED.json'))).toBe(true);
    expect(readServerMigrateJournal(f.target)).toBeUndefined();
  });

  it('rolls the whole group back to the old units, sites and legacy home when one instance fails its health check', async () => {
    const f = sharedHome();
    const records = readFileSync(f.legacy.serverState('default'));
    f.host.unhealthy.add('hearsay-squawk-shop.service');
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'rolled-back' });
    expectOldGroup(f);
    expect(readFileSync(f.legacy.serverState('default'))).toEqual(records);
  });

  it('is a no-op after success and migrates again after a rollback', async () => {
    const f = sharedHome();
    f.host.unhealthy.add('hearsay-squawk.service');
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'rolled-back' });
    f.host.unhealthy.clear();
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'migrated' });
    const commands = f.host.commands.length;
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'unchanged' });
    expect(f.host.commands).toHaveLength(commands);
  });

  it('refuses writes to the pending home while the new cockpits serve it read-only', async () => {
    const f = sharedHome();
    const seen: Array<{ write: string; readOnlyBoot: boolean }> = [];
    f.host.onUpstreamProbe = () => {
      if (seen.length || readInstallMarker(f.target.config)?.state !== 'pending') return;
      let write = 'accepted';
      try { new HomeStore(f.target).writeJson(f.target.workspaceConfig, { lost: true }); } catch (error) { write = (error as Error).message; }
      seen.push({ write, readOnlyBoot: prepareMigrationHome(f.target, f.env, { legacy: f.legacy }).kind === 'staged' });
    };
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'migrated' });
    expect(seen).toEqual([{ write: expect.stringMatching(/pending migration home/), readOnlyBoot: true }]);
    expect(JSON.parse(readFileSync(f.target.workspaceConfig, 'utf8'))).not.toHaveProperty('lost');
  });

  it('recovers a crash between two instance moves from the journal and the disk', async () => {
    const f = sharedHome();
    let crashed!: () => void;
    const crash = new Promise<void>(resolve => { crashed = resolve; });
    f.host.hang = command => command.includes('hearsay-squawk-shop.service') && (crashed(), true);
    void serverMigrate(f);
    await crash;
    const journal = readServerMigrateJournal(f.target);
    expect(journal?.phase).toBe('migrating');
    expect(journal?.instances.map(i => [i.instance, i.planned.moved.length, i.moved?.moved.length])).toEqual([['default', 4, 4], ['shop', 4, undefined]]);
    expect(existsSync(userUnit(f, 'cezar.service.migrated'))).toBe(true);
    delete f.host.hang;
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'migrated' });
    expect(f.host.enabledSites()).toEqual(['hearsay-squawk', 'hearsay-squawk-shop']);
    expect(f.host.unit('system', 'hearsay-squawk-shop.service')).toMatchObject({ enabled: true, active: true });
    expect(readInstallMarker(f.target.config)?.state).toBe('committed');
  });

  it('leaves no probe login after a crash between its append and its removal', async () => {
    const f = sharedHome();
    let crashed!: () => void;
    const crash = new Promise<void>(resolve => { crashed = resolve; });
    f.host.hang = command => command.startsWith('sed -i') && command.includes('cez-migrate-probe-') && (crashed(), true);
    void serverMigrate(f);
    await crash;
    expect(f.host.read('/etc/hearsay-squawk/htpasswd')).toMatch(/^cez-migrate-probe-[0-9a-f]{12}:/m);
    delete f.host.hang;
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'migrated' });
    for (const file of ['/etc/hearsay-squawk/htpasswd', '/etc/hearsay-squawk/htpasswd-shop', '/etc/cezar/htpasswd', '/etc/cezar/htpasswd-shop']) {
      expect(f.host.read(file)).not.toContain('cez-migrate-probe');
    }
  });

  it('never prints the probe password and draws it from 192 random bits', async () => {
    const f = sharedHome();
    const inputs: string[] = [];
    const capture = f.host.capture.bind(f.host);
    f.host.capture = async (program, args, opts) => {
      if (program === 'curl' && opts?.input?.includes('cez-migrate-probe')) inputs.push(opts.input);
      return capture(program, args, opts);
    };
    const result = await serverMigrate(f);
    expect(result.status).toBe('migrated');
    const passwords = inputs.map(input => /user = "[^:]+:(.*)"/.exec(input)![1]!);
    expect(passwords.length).toBeGreaterThan(0);
    for (const password of passwords) {
      expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect([...result.lines, ...f.host.commands].join('\n')).not.toContain(password);
    }
  });

  it('rolls the group back when a legacy write during the health checks refuses the commit, then migrates again', async () => {
    const f = sharedHome();
    f.host.onUpstreamProbe = () => {
      if (readInstallMarker(f.target.config)?.state !== 'pending') return;
      // A journaled legacy write; an unjournaled one also waits for home recovery (P2b-1).
      Home.seed(f.legacy, f.legacy.workspaceConfig, { projects: [], saved: 'during checks' });
      delete f.host.onUpstreamProbe;
    };
    const result = await serverMigrate(f);
    expect(result).toMatchObject({ status: 'rolled-back' });
    expect(result.lines.join('\n')).toMatch(/kept changing|changed/i);
    expectOldGroup(f);
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'migrated' });
    expect(JSON.parse(readFileSync(f.target.workspaceConfig, 'utf8'))).toMatchObject({ saved: 'during checks' });
  });

  it('finishes forward when a crash left a migrating journal over a home this run committed', async () => {
    const f = sharedHome();
    let crashed!: () => void;
    const crash = new Promise<void>(resolve => { crashed = resolve; });
    f.host.hang = command => command.startsWith('sed -i') && command.includes('htpasswd-shop') && (crashed(), true);
    void serverMigrate(f);
    await crash;
    commitLegacyMigration(f.target, f.env); // The commit landed; the journal write did not.
    expect(readServerMigrateJournal(f.target)).toMatchObject({ phase: 'migrating', stagedHome: true });
    delete f.host.hang;
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'migrated' });
    expect(unitName(f, 'shop')).toBe('hearsay-squawk-shop.service');
    expect(f.host.enabledSites()).toEqual(['hearsay-squawk', 'hearsay-squawk-shop']);
    expect(readServerMigrateJournal(f.target)).toBeUndefined();
  });

  it('treats a failed disable of a new unit as a failed rollback', async () => {
    const f = sharedHome();
    f.host.unhealthy.add('hearsay-squawk-shop.service');
    f.host.failDisable.add('hearsay-squawk.service');
    // ast-grep-ignore: test-enum-literal — a server-migrate result status, not a run status.
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'failed' });
    expect(readServerMigrateJournal(f.target)?.phase).toBe('rolling-back');
    f.host.failDisable.clear();
    f.host.unhealthy.clear();
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'migrated' });
  });

  it('keeps the journal after a failed compensation and finishes the rollback on the next run', async () => {
    const f = sharedHome();
    f.host.unhealthy.add('hearsay-squawk-shop.service');
    // The first site rollback (shop, reverse order) then fails its nginx -t.
    f.host.onUpstreamProbe = () => { f.host.nginxTestFailures = 1; delete f.host.onUpstreamProbe; };
    // ast-grep-ignore: test-enum-literal — a server-migrate result status, not a run status.
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'failed' });
    expect(readServerMigrateJournal(f.target)?.phase).toBe('rolling-back');
    expect(readInstallMarker(f.target.config)?.state).toBe('pending');
    f.host.unhealthy.clear();
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'migrated' });
    expect(f.host.enabledSites()).toEqual(['hearsay-squawk', 'hearsay-squawk-shop']);
    expect(f.host.exists('/etc/nginx/sites-available/hearsay-squawk-shop')).toBe(true);
  });
});

describe('server-migrate sites and credentials', () => {
  it('keeps TLS listeners, certificates and the HTTP-to-HTTPS redirect, changing only the name and htpasswd path', async () => {
    const f = sharedHome();
    const old = f.host.read('/etc/nginx/sites-available/cezar');
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'migrated' });
    const copied = f.host.read('/etc/nginx/sites-available/hearsay-squawk');
    expect(copied).toBe(old.replace('auth_basic_user_file /etc/cezar/htpasswd;', 'auth_basic_user_file /etc/hearsay-squawk/htpasswd;'));
    expect(copied).toMatch(/listen 443 ssl;[\s\S]*ssl_certificate \/etc\/letsencrypt\/live\/cockpit\.example\.com\/fullchain\.pem;[\s\S]*return 301 https:/);
    expect(f.host.read('/etc/nginx/sites-available/cezar')).toBe(old);
  });

  it.each([
    ['a public IPv4 address', '203.0.113.5:443 ssl', '203.0.113.5'],
    ['an IPv6-only wildcard', '[::]:443 ssl ipv6only=on', '[::1]'],
    ['a concrete IPv6 address', '[2001:db8::5]:443 ssl', '[2001:db8::5]'],
  ])('checks the public URL on the address the site listens on: %s', async (_case, listen, address) => {
    const f = serverFixture();
    installInstance(f, { instance: 'default', port: 4321, domain: 'cockpit.example.com', tls: true, listen });
    const urls: string[] = [];
    const capture = f.host.capture.bind(f.host);
    f.host.capture = async (program, args, opts) => {
      if (program === 'curl' && args.includes('--resolve')) urls.push(`${args[args.indexOf('--resolve') + 1]} ${args.at(-1)}`);
      return capture(program, args, opts);
    };
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'migrated' });
    expect(urls).toContain(`cockpit.example.com:443:${address} https://cockpit.example.com/`);
  });

  it('chooses the probe address from the listeners of the port', () => {
    const site = (...lines: string[]) => lines.map(line => `    listen ${line};\n`).join('');
    expect(listenAddress(site('443 ssl', '[::]:443 ssl'), 443)).toBe('127.0.0.1');
    expect(listenAddress(site('[::]:443 ssl', '*:443 ssl'), 443)).toBe('127.0.0.1');
    expect(listenAddress(site('[::]:443 ssl ipv6only=on'), 443)).toBe('[::1]');
    expect(listenAddress(site('[2001:db8::5]:443 ssl', '[::]:443 ssl'), 443)).toBe('[2001:db8::5]');
    expect(listenAddress(site('203.0.113.5:80', '[::]:443 ssl'), 443)).toBe('[::1]');
    expect(listenAddress(site('80'), 443)).toBe('127.0.0.1');
  });

  it('rolls back when the copied site does not serve the public name', async () => {
    const f = serverFixture();
    installInstance(f, { instance: 'shop', port: 4322, domain: 'shop.example.com', serverName: 'other.example.com' });
    const result = await serverMigrate(f);
    expect(result).toMatchObject({ status: 'rolled-back' });
    expect(result.lines.join('\n')).toContain('http://shop.example.com/ did not ask for a login (got 404)');
    expect(f.host.enabledSites()).toEqual(['cezar-shop']);
    expect(f.host.unit('user', 'hearsay-squawk-shop.service')).toMatchObject({ enabled: false, active: false });
  });

  it('commits only after the public HTTPS URL passes', async () => {
    const f = sharedHome();
    f.host.tlsBroken = true;
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'rolled-back' });
    expectOldGroup(f);
  });

  it('a password rotated in the new htpasswd works and the old file no longer authenticates', async () => {
    const f = sharedHome();
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'migrated' });
    f.host.write('/etc/hearsay-squawk/htpasswd', `ops:${fakeHash('rotated')}\n`);
    const login = (password: string) => f.host.capture('curl',
      ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-k', '-H', 'Host: cockpit.example.com', '-K', '-', 'https://127.0.0.1/'], { input: `user = "ops:${password}"\n` });
    await expect(login('rotated')).resolves.toMatchObject({ stdout: '200' });
    await expect(login('old-secret')).resolves.toMatchObject({ stdout: '401' });
    expect(f.host.read('/etc/cezar/htpasswd')).toContain(fakeHash('old-secret'));
    expect(f.host.read('/etc/hearsay-squawk/htpasswd')).not.toContain('cez-migrate-probe');
  });

  it('moves only the unit of an --external-proxy install and leaves its proxy untouched', async () => {
    const f = serverFixture();
    installInstance(f, { instance: 'api', port: 4400, domain: 'api.example.com', externalProxy: true });
    f.host.write('/etc/traefik/dynamic/cezar.yml', 'routers: {}\n');
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'migrated' });
    expect(f.host.unit('user', 'hearsay-squawk-api.service')).toMatchObject({ enabled: true, active: true });
    expect(f.host.read('/etc/traefik/dynamic/cezar.yml')).toBe('routers: {}\n');
    expect(f.host.exists('/etc/hearsay-squawk')).toBe(false);
    expect(f.host.enabledSites()).toEqual([]);
    expect(f.host.commands.join('\n')).not.toMatch(/nginx|htpasswd/);
  });
});

describe('server-migrate dry run and environment', () => {
  it('names the stop, each health check, the group, the pending marker and the rollback', async () => {
    const f = sharedHome();
    installInstance(f, { instance: 'api', port: 4400, domain: 'api.example.com', externalProxy: true });
    const result = await serverMigrate(f, { dryRun: true });
    expect(result.status).toBe('planned');
    const marker = join(f.target.config, 'install.json');
    expect(result.lines[0]).toBe('stop: every instance that shares this home stops first (default, api, shop)');
    for (const line of [
      'default: health check: port 4321 answers, then https://cockpit.example.com/ (HTTPS, the site has TLS) asks for a login and accepts a probe login',
      'shop: health check: port 4322 answers, then http://shop.example.com/ (HTTP, the site has no TLS) asks for a login and accepts a probe login',
      'api: health check: http://127.0.0.1:4400/ answers (the bind address; the proxy is not checked)',
      'group: default, api, shop succeed or fail together. Each instance starts under its new name and passes its health check before the group commits.',
      `marker: ${marker} stays pending (the new home is read-only) until every instance passes, then commits.`,
      'rollback: any failure restores every old service definition (systemd units and nginx sites, launchd plists), starts the old services and renames the marker to install.json.failed; the legacy home stays in use. A restore error leaves its instance stopped and the rollback journal in place: fix the reported error and re-run server-migrate to finish the rollback. A restored service that fails its start check is reported as a warning.',
    ]) expect(result.lines).toContain(line);
    expect(f.host.commands).toEqual([]);
  });


  it('carries a custom CEZ_HOME line and lists every unit, site, file and environment line without changing anything', async () => {
    const f = serverFixture();
    installInstance(f, { instance: 'default', port: 4321, environment: ['Environment=CEZ_HOME=/srv/cez-home', 'Environment=GH_TOKEN=do-not-print'] });
    const result = await serverMigrate(f, { dryRun: true });
    expect(result.status).toBe('planned');
    const lines = result.lines.join('\n');
    for (const line of [
      `default: unit user cezar.service → hearsay-squawk.service (old file kept as ${userUnit(f, 'cezar.service')}.migrated)`,
      'default: site /etc/nginx/sites-available/cezar → /etc/nginx/sites-available/hearsay-squawk (copied; auth_basic_user_file /etc/cezar/htpasswd → /etc/hearsay-squawk/htpasswd)',
      'default: enabled site /etc/nginx/sites-enabled/cezar → /etc/nginx/sites-enabled/hearsay-squawk',
      'default: file /etc/cezar/htpasswd → /etc/hearsay-squawk/htpasswd (copied; old file kept)',
      'default: environment CEZ_HOME=/srv/cez-home carried',
      'default: environment GH_TOKEN carried (value not shown)',
    ]) expect(lines).toContain(line);
    // Each move prints once: the platform's detail line replaces the raw move line.
    expect(lines).not.toMatch(/^default: (autostart|nginx-proxy) /m);
    expect(lines).toMatch(/^home: .* files copied/m);
    expect(lines).not.toContain('do-not-print');
    expect(f.host.commands).toEqual([]);
    expect(readInstallMarker(f.target.config)?.state).toBeUndefined();
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'migrated' });
    expect(readFileSync(userUnit(f, 'hearsay-squawk.service'), 'utf8')).toContain('Environment=CEZ_HOME=/srv/cez-home\n');
  });
});
