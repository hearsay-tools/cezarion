import { join } from 'node:path';
import { Home } from '../home/home.ts';
import { migrationFixture } from '../home/migration.testkit.ts';
import { runServerMigrate, type ServerMigrateOptions } from './group-migrate.ts';
import { createUbuntuVps, nginxVhost, systemdUnit } from './platforms/ubuntu-vps.ts';
import { ubuntuNames } from './platforms/ubuntu-vps-names.ts';
import { fakeHash, FakeUbuntuHost } from './platforms/ubuntu-host.testkit.ts';
import { createAutoUi } from './ui.ts';
import { STEP_STATUSES, type ServerState, type StepArtifact } from './types.ts';
import { z } from 'zod';

const { done, skipped } = z.enum(STEP_STATUSES).enum;

export interface InstanceSpec {
  instance: string;
  port: number;
  scope?: 'user' | 'system';
  domain?: string;
  tls?: boolean;
  externalProxy?: boolean;
  environment?: string[];
  /** The TLS listener's own arguments, as in `listen 203.0.113.5:443 ssl`. */
  listen?: string;
  /** A server_name other than the recorded domain. */
  serverName?: string;
}

export function serverFixture() {
  const fixture = migrationFixture();
  const host = new FakeUbuntuHost(join(fixture.directory, 'host'), join(fixture.directory, 'host', 'user-units'));
  return { ...fixture, host };
}
export type ServerFixture = ReturnType<typeof serverFixture>;

/** What certbot --nginx leaves behind: a TLS listener, its certificate and an HTTP redirect block. */
export function certbotSite(site: string, domain: string, listen = '443 ssl'): string {
  const tls = `    listen ${listen}; # managed by Certbot\n    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem; # managed by Certbot\n` +
    `    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem; # managed by Certbot\n`;
  const at = site.lastIndexOf('}');
  return `${site.slice(0, at).replace(/ {4}listen 80;\n {4}listen \[::\]:80;\n/, '')}${tls}}\n` +
    `server {\n    if ($host = ${domain}) {\n        return 301 https://$host$request_uri;\n    } # managed by Certbot\n` +
    `    listen 80;\n    server_name ${domain};\n    return 404; # managed by Certbot\n}\n`;
}

/** A completed pre-switch install: running unit, enabled site, htpasswd and its server record. */
export function installInstance({ host, legacy }: ServerFixture, spec: InstanceSpec): ServerState {
  const names = ubuntuNames(spec.instance, { legacy: true });
  const scope = spec.scope ?? 'user';
  const unitPath = scope === 'user' ? join(host.userUnitDir, names.unit) : `/etc/systemd/system/${names.unit}`;
  const unit = systemdUnit('/srv/repo', spec.port, scope, '/usr/bin/node /opt/cezar/dist/index.js')
    .replace(/(Environment=PATH=.*\n)/, `$1${(spec.environment ?? []).map(line => `${line}\n`).join('')}`);
  host.write(unitPath, unit);
  Object.assign(host.unit(scope, names.unit), { enabled: true, active: true });
  const steps: ServerState['steps'] = {
    deps: { status: done, created: { artifacts: [] } },
    autostart: { status: done, created: { artifacts: [{ kind: 'owned', type: 'service', name: names.unit, scope, path: unitPath }] } },
    identity: { status: done, created: { artifacts: [] } },
  };
  if (!spec.externalProxy) {
    const site = nginxVhost(spec.port, spec.serverName ?? spec.domain ?? '_', names.htpasswd);
    host.write(names.vhostAvailable, spec.tls ? certbotSite(site, spec.serverName ?? spec.domain!, spec.listen) : site);
    host.link(names.vhostAvailable, names.vhostEnabled);
    host.write(names.htpasswd, `ops:${fakeHash('old-secret')}\n`);
    const artifacts: StepArtifact[] = [
      { kind: 'owned', type: 'file', path: names.vhostAvailable },
      { kind: 'owned', type: 'symlink', path: names.vhostEnabled },
      { kind: 'owned', type: 'htpasswd', path: names.htpasswd, name: 'ops' },
    ];
    steps['nginx-proxy'] = { status: done, created: { artifacts } };
    steps.ssl = spec.tls ? { status: done, created: { artifacts: [{ kind: 'shared', type: 'cert', name: spec.domain! }] } } : { status: skipped, created: null };
    host.reloadNginx();
  }
  const state = {
    schema: 1 as const, platform: 'ubuntu-vps', instance: spec.instance, installed: true, primaryPort: spec.port, steps,
    ...(spec.domain ? { domain: spec.domain } : {}),
    ...(spec.tls ? { publicUrl: `https://${spec.domain}` } : {}),
    ...(spec.externalProxy ? { externalProxy: true, bindHost: '127.0.0.1' } : {}),
  };
  Home.seed(legacy, legacy.serverState(spec.instance), state);
  return state;
}

export function serverMigrate(f: ServerFixture, over: Partial<ServerMigrateOptions> = {}) {
  return runServerMigrate({
    legacy: f.legacy, target: f.target, strategy: () => createUbuntuVps(), dryRun: false, assumeYes: true,
    repoRoot: '/srv/repo', now: '2026-11-07T00:00:00.000Z', ui: createAutoUi(), runner: f.host, env: f.env, ...over,
  });
}

/** Two instances that share one home: a TLS default site on a user unit and a named system unit. */
export function sharedHome() {
  const f = serverFixture();
  installInstance(f, { instance: 'default', port: 4321, domain: 'cockpit.example.com', tls: true });
  installInstance(f, { instance: 'shop', port: 4322, domain: 'shop.example.com', scope: 'system' });
  return f;
}
