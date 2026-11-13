import { Home } from '../home/home.ts';
import { useTestHome } from '../home/test-home.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { availablePlatformIds, getStrategy, supportsServerMigration } from './strategies.ts';
import { runInstall } from './engine.ts';
import { loadServerState } from './state.ts';
import { createAutoUi } from './ui.ts';
import { nginxVhost } from './platforms/ubuntu-vps.ts';
import { MIGRATABLE_PLATFORM_IDS, type Runner } from './types.ts';

const noRunner: Runner = { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 };

describe('registry', () => {
  it('keeps the boot migration platform list equal to the strategy capabilities', () => {
    expect([...MIGRATABLE_PLATFORM_IDS].sort()).toEqual(
      availablePlatformIds().filter((id) => supportsServerMigration(getStrategy(id))).sort(),
    );
  });

  it('resolves ubuntu-vps and lists available ids', () => {
    expect(getStrategy('ubuntu-vps')?.id).toBe('ubuntu-vps');
    expect(getStrategy('nope')).toBeUndefined();
    expect(availablePlatformIds()).toContain('ubuntu-vps');
  });
});

describe('nginxVhost', () => {
  it('points at the loopback port and disables SSE buffering', () => {
    const v = nginxVhost(4321);
    expect(v).toContain('proxy_pass http://127.0.0.1:4321;');
    expect(v).toContain('proxy_buffering off;');
    expect(v).not.toMatch(/^\s*http2\s/m);
    expect(v).toContain('auth_basic_user_file /etc/cezar/htpasswd;');
  });
});

describe('ubuntu-vps dry-run', () => {
  let home: string;
  const original = process.env.CEZ_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-ubuntu-'));
    useTestHome(home ? Home.sandbox(home) : undefined);
  });
  afterEach(() => {
    if (original === undefined) useTestHome(undefined);
    else useTestHome(original ? Home.sandbox(original) : undefined);
    rmSync(home, { recursive: true, force: true });
  });

  it('walks every Phase-1 step and writes a complete server.json', async () => {
    const strategy = getStrategy('ubuntu-vps')!;
    const res = await runInstall(strategy, { home: testHome(),
      dryRun: true,
      assumeYes: true,
      reconfigure: new Set(),
      repoRoot: '/repo',
      now: '2026-07-16T00:00:00.000Z',
      ui: createAutoUi({ 'Missing tools — select the ones to install': [] as string[] }),
      runner: noRunner,
    });
    expect(res.status).toBe('complete');
    const state = loadServerState(undefined, testHome());
    expect(state.platform).toBe('ubuntu-vps');
    expect(state.steps.deps?.status).toBe('done');
    expect(state.steps['nginx-proxy']?.status).toBe('done');
    expect(state.steps.identity?.status).toBe('done');
    expect(state.installed).toBe(true);
  });
});
