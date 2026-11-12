import { scrubProbeSessionEnv } from '../../scripts/probe-session-env.ts';
import { resolveCapabilities } from '../server/capabilities.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from '../home/home.ts';
import { agentEnv } from '../workflows/run/launch-context.ts';
import { worktreeSetupEnv } from '../worktree-setup.ts';
import { withPreviewCdp } from '../preview/agent-address.ts';
import { buildChildEnv } from './agent-env.ts';
import { productEnvEntries } from './product-env.ts';
import { squawkToolEnvNames } from '../ci-wait/tools.ts';
import { systemdUnit } from '../server-install/platforms/ubuntu-vps.ts';
import { squawkLaunchdPlist } from '../server-install/platforms/macosx-ngrok.ts';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });

it.each([false, true])('launch context and continuation env generate matching names with rebrand=%s', rebrand => {
  const root = mkdtempSync(join(tmpdir(), 'env-launch-')); roots.push(root);
  const context = {dataDir: root, repoRoot: root, home: Home.sandbox(join(root, 'home'))} as Parameters<typeof agentEnv>[0];
  const generated = agentEnv(context, {origin: 'http://127.0.0.1:4321', projectId: 'project'}, 'run-id', rebrand);
  for (const suffix of ['ARTIFACTS_DIR', 'HANDOFF_FILE', 'TASK_ID', 'TODOS_FILE', 'COCKPIT_URL', 'PROJECT_ID']) {
    expect(generated[`CEZ_${suffix}`]).toBeDefined();
    expect(generated[`HSQ_${suffix}`]).toBe(rebrand ? generated[`CEZ_${suffix}`] : undefined);
  }
  expect(generated.CEZ_TODOS_FILE).toBe('');
  expect(agentEnv(context, undefined, 'run-id', rebrand).CEZ_COCKPIT_URL).toBeUndefined();
  for (const full of ['0', '1']) {
    const env = buildChildEnv({backend: 'codex', source: {CEZ_HOME: '/host', HSQ_HOME: '/host-new', HSQ_AGENT_ENV_FULL: full, HSQ_ENV_PASSTHROUGH: 'HSQ_PROJECT_ID,HSQ_TOOL_TOKEN', HSQ_PROJECT_ID: 'wrong', HSQ_TOOL_TOKEN: 'parent'}, extraEnv: generated});
    expect(env.CEZ_PROJECT_ID).toBe('project');
    expect(env.HSQ_PROJECT_ID).toBe(rebrand ? 'project' : undefined);
    expect(env.HSQ_TOOL_TOKEN).toBeUndefined(); expect(env.CEZ_HOME).toBeUndefined(); expect(env.HSQ_HOME).toBeUndefined();
  }
});

it.each([false, true])('worktree setup owns both aliases and keeps command auth curated with rebrand=%s', rebrand => {
  const env = worktreeSetupEnv({projectRoot: '/project', runId: 'task', tmpEnv: {TMPDIR: '/scratch'}, rebrand,
    source: {HSQ_TASK_ID: 'parent', HSQ_PROJECT_ROOT: '/parent', GITHUB_TOKEN: 'host', HSQ_HOME: '/host', PATH: '/bin'}});
  expect(env).toMatchObject({CEZ_TASK_ID: 'task', CEZ_PROJECT_ROOT: '/project', TMPDIR: '/scratch', PATH: '/bin'});
  expect(env.HSQ_TASK_ID).toBe(rebrand ? 'task' : undefined);
  expect(env.HSQ_PROJECT_ROOT).toBe(rebrand ? '/project' : undefined);
  expect(env.GITHUB_TOKEN).toBeUndefined(); expect(env.HSQ_HOME).toBeUndefined();
});

it.each([false, true])('preview capability binds matching aliases and revokes both resources with rebrand=%s', rebrand => {
  const session = {env: {CEZ_TOOL_TOKEN: 'tool'} as Record<string, string>, revoke: vi.fn()};
  const grant = {token: 'preview-token', revoke: vi.fn()};
  const decorated = withPreviewCdp(session, grant, 'https://cockpit.example', rebrand);
  expect(decorated.env.CEZ_PREVIEW_CDP_URL).toBe('wss://cockpit.example/api/v1/preview/cdp/preview-token');
  expect(decorated.env.HSQ_PREVIEW_CDP_URL).toBe(rebrand ? decorated.env.CEZ_PREVIEW_CDP_URL : undefined);
  decorated.revoke(); expect(session.revoke).toHaveBeenCalledOnce(); expect(grant.revoke).toHaveBeenCalledOnce();
});

it('generated intentional clears and native adapter allowlists preserve preferred empty values', () => {
  expect(productEnvEntries('TODOS_FILE', '', false)).toEqual({CEZ_TODOS_FILE: ''});
  expect(productEnvEntries('TODOS_FILE', '', true)).toEqual({HSQ_TODOS_FILE: '', CEZ_TODOS_FILE: ''});
  expect(squawkToolEnvNames({CEZ_AUTOMATIONS: '0', HSQ_AUTOMATIONS: '', HSQ_TOOL_TOKEN: 'token'})).toEqual([
    'CEZ_TOOL_TOKEN', 'HSQ_TOOL_TOKEN', 'CEZ_TOOL_SOCKET', 'CEZ_AUTOMATIONS', 'HSQ_AUTOMATIONS',
  ]);
});

it.each([false, true])('service installers emit matching REMOTE env names with rebrand=%s', rebrand => {
  const unit = systemdUnit('/repo', 4321, 'user', '/bin/cez', undefined, rebrand);
  expect(unit).toContain('Environment=CEZ_REMOTE=1');
  expect(unit).toContain('Environment=HSQ_REMOTE=1');
  const installed = Object.fromEntries([...unit.matchAll(/^Environment=(\w+)=(.*)$/gm)].map(match => [match[1]!, match[2]!]));
  expect(resolveCapabilities({HSQ_REMOTE: '0', ...installed}, '127.0.0.1')).toMatchObject({localHandoff: false, settingsAdmin: false});
  const plist = squawkLaunchdPlist('/repo', 4321, ['/bin/cez'], rebrand);
  expect(plist).toContain('<key>CEZ_REMOTE</key>\n      <string>1</string>');
  expect(plist).toContain('<key>HSQ_REMOTE</key>\n      <string>1</string>');
  const agent = Object.fromEntries([...plist.matchAll(/<key>((?:CEZ|HSQ)_REMOTE)<\/key>\s*<string>([^<]*)<\/string>/g)].map(match => [match[1]!, match[2]!]));
  expect(resolveCapabilities({HSQ_REMOTE: '0', ...agent}, '127.0.0.1')).toMatchObject({localHandoff: false, settingsAdmin: false});
});

it('approval probes drop both session prefixes and retain matching operator auth names', () => {
  const env: NodeJS.ProcessEnv = {CEZ_TOOL_TOKEN: 'parent', HSQ_TOOL_TOKEN: 'parent', CLAUDE_CODE_SESSION: 'parent',
    CEZ_ENV_PASSTHROUGH: 'KEY', HSQ_ENV_PASSTHROUGH: 'OTHER', CEZ_AGENT_ENV_FULL: '1', HSQ_AGENT_ENV_FULL: '0',
    CEZ_CODEX_BIN: '/legacy', HSQ_CODEX_BIN: '/preferred', PATH: '/bin'};
  scrubProbeSessionEnv(env);
  expect(env).toEqual({CEZ_ENV_PASSTHROUGH: 'KEY', HSQ_ENV_PASSTHROUGH: 'OTHER', CEZ_AGENT_ENV_FULL: '1', HSQ_AGENT_ENV_FULL: '0', CEZ_CODEX_BIN: '/legacy', HSQ_CODEX_BIN: '/preferred', PATH: '/bin'});
});
