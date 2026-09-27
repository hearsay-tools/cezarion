import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { DelegationController } from '../delegation/provision.ts';
import { fixture } from '../delegation/service.testkit.ts';
import { createDelegationRoutes } from '../delegation/routes.ts';
import { createDelegationApp, startDelegationTransport } from '../delegation/transport.ts';
import { RunnerModelCatalog } from '../core/runner-model-catalog.ts';
import { connectedProviderAuth } from '../server/provider-auth.testkit.ts';
import { createApp } from '../server/server.ts';
import { runDiscoverCommand } from './cli.ts';

describe('cez discover', () => {
  let f: ReturnType<typeof fixture>;
  let privateTransport: Awaited<ReturnType<typeof startDelegationTransport>>;
  let server: ServerType;
  let origin: string;
  let output: string[];
  beforeEach(async () => {
    vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); output = [];
    const models = new RunnerModelCatalog({ adapters: { codex: { discover: async () => [
      { id: 'current', label: 'Current', description: '', effortLevels: ['low', 'high'] },
      { id: 'unknown-efforts', label: 'Unknown', description: '' },
      { id: 'no-efforts', label: 'None', description: '', effortLevels: [] },
    ] } } });
    // createApp must wire the very same catalog into the private controller.
    const app = createApp({ repoRoot: f.root, store: f.store, manager: f.manager, version: 'test', modelCatalog: models, providerAuth: connectedProviderAuth(), delegation: Object.assign(new DelegationController(), { service: f.service }) });
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>(resolve => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    privateTransport = await startDelegationTransport(createDelegationApp(createDelegationRoutes(f.service, f.credentials)));
  });
  afterEach(async () => {
    await privateTransport?.close();
    if (server) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await f?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  });
  const env = () => ({ CEZ_DELEGATION_URL: privateTransport.url, CEZ_DELEGATION_TOKEN: f.token });
  const run = (args: string[], environment: NodeJS.ProcessEnv = {}) => runDiscoverCommand(args, environment, { stdout: line => output.push(line), discover: async () => ({ origin, projectId: 'default', api: `${origin}/api/v1/p/default` }) });
  const last = () => JSON.parse(output.at(-1)!);
  it('gives operators and parents the same model rows, preserving unknown versus empty effort metadata', async () => {
    expect(await run(['models', '--runner=codex'])).toBe(0);
    const operator = last();
    expect(operator).toMatchObject({ runner: 'codex', source: 'live', stale: false });
    expect(operator.models).toEqual([
      { id: 'current', label: 'Current', description: '', effortLevels: ['low', 'high'] },
      { id: 'unknown-efforts', label: 'Unknown', description: '' },
      { id: 'no-efforts', label: 'None', description: '', effortLevels: [] },
    ]);
    expect(await run(['models', '--runner=codex'], env())).toBe(0);
    expect(last()).toEqual({ ...operator, source: 'cache' });
  });
  it('lists runner status and scope for operators and parents', async () => {
    expect(await run(['runners'])).toBe(0);
    const operator = last();
    expect(operator).toMatchObject({ scope: 'host-default-account', runners: expect.arrayContaining([{ runner: 'codex', status: 'connected', enabled: true }]) });
    expect(await run(['runners'], env())).toBe(0);
    expect(last()).toEqual(operator);
  });
  it('returns unavailable catalogs without inventing models', async () => {
    expect(await run(['models', '--runner=pi'], env())).toBe(0);
    expect(last()).toMatchObject({ runner: 'pi', models: [], source: 'unavailable', reason: expect.any(String) });
  });
  it('never falls back to the cockpit on stale or partial delegation credentials', async () => {
    for (const bad of [{ ...env(), CEZ_DELEGATION_TOKEN: 'x'.repeat(43) }, { CEZ_DELEGATION_URL: privateTransport.url }, { CEZ_DELEGATION_TOKEN: f.token }]) {
      expect(await run(['runners'], bad)).not.toBe(0);
      expect(last()).not.toHaveProperty('runners');
      expect(output.at(-1)).not.toContain(f.token);
    }
    expect(await run(['runners', '--url', origin], env())).not.toBe(0);
  });
  it('refuses worker credentials even though the public cockpit is reachable', async () => {
    const { workerId } = await f.service.spawn(f.caller, { task: 'child', baseline: 'HEAD', requestId: randomUUID() });
    const token = f.credentials.issue('project', workerId, randomUUID());
    expect(await run(['runners'], { ...env(), CEZ_DELEGATION_TOKEN: token })).not.toBe(0);
    expect(last().code).toBe('denied_scope');
  });
  it.each([['models'], ['models', '--runner=bogus'], ['runners', '--runner=codex'], ['effort-levels'], ['models', '--runner=codex', '--backend=codex']])('rejects invalid usage %j', async (...args) => {
    expect(await run(args)).toBe(64);
    expect(last().code).toBe('invalid_input');
  });
  it('prints help without a controller or catalog', async () => {
    expect(await run(['--help'], { CEZ_DELEGATION_TOKEN: 'bad' })).toBe(0);
    expect(output.join('\n')).toContain('models --runner');
  });
});

it('dispatches discovery before global CLI parsing and needs no controller for help', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../index.ts', import.meta.url)), 'discover', 'models', '--runner=codex', '--help']);
  expect(stdout).toContain('cez discover models');
  expect(stdout).not.toContain('start the cockpit');
}, 15000);
