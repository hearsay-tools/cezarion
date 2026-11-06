import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveHome } from './resolve.ts';
import type { Home } from './home.ts';
import { atomicWriteJsonSync } from '../workspace/config.ts';
import { currentEntry, linkCheckout, readManifest, writeManifest } from '../self-update/layout.ts';
import { SelfUpdateService } from '../self-update/service.ts';
import { RegistryCache } from '../self-update/registry.ts';

const roots: string[] = [];
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function checkout(root: string, branch: string): string {
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'web', 'dist'), { recursive: true });
  atomicWriteJsonSync(join(root, 'package.json'), { name: '@wjarka/cezarion', version: '1.2.3' });
  writeFileSync(join(root, 'dist', 'index.js'), root);
  writeFileSync(join(root, 'web', 'dist', 'index.html'), '<!doctype html>');
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
  return realpathSync(root);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cez-discovery-home-')); roots.push(root);
  const selected = resolveHome({ purpose: 'cli', env: { CEZ_HOME: join(root, 'selected') } });
  const ambient = resolveHome({ purpose: 'cli', env: { CEZ_HOME: join(root, 'ambient') } });
  const selectedRegistry = checkout(join(root, 'selected-registry'), 'registry');
  const selectedLink = checkout(join(root, 'selected-link'), 'main');
  const ambientRegistry = checkout(join(root, 'ambient-registry'), 'registry');
  const ambientLink = checkout(join(root, 'ambient-link'), 'main');
  atomicWriteJsonSync(selected.workspaceConfig, { projects: [{ id: 'selected', root: selectedRegistry }] });
  atomicWriteJsonSync(ambient.workspaceConfig, { projects: [{ id: 'ambient', root: ambientRegistry }] });
  linkCheckout(selectedLink, 'main', process.env, undefined, selected);
  linkCheckout(ambientLink, 'main', process.env, undefined, ambient);
  // This ambient install must not force a suffix on the selected registry checkout's id.
  writeManifest('1.2.3+registry', { version: '1.2.3', source: 'local', installedAt: '' }, process.env, ambient);
  vi.stubEnv('CEZ_HOME', ambient.root);
  return { selected, ambient, selectedRegistry, selectedLink, ambientLink };
}

function service(home: Home) {
  return new SelfUpdateService({ pkgName: '@wjarka/cezarion', version: '1.2.3',
    entry: currentEntry(process.env, home), home, restart: () => {},
    registry: new RegistryCache('@wjarka/cezarion', async () => new Response('', { status: 503 })),
    pulls: async () => ({ available: true, items: [] }),
  });
}

it('discovers the injected Home registry, links and install ids, ignoring the ambient Home', async () => {
  const { selected, selectedRegistry, selectedLink } = fixture();
  const development = await service(selected).development();
  expect(development.checkouts.map(entry => entry.worktree).sort()).toEqual([selectedRegistry, selectedLink].sort());
  expect(development.checkouts.find(entry => entry.worktree === selectedRegistry)?.id).toBe('1.2.3+registry');
  expect(development.checkouts.find(entry => entry.worktree === selectedLink)?.linked).toBe(true);
});

it('applies a same-id linked checkout from the injected Home', async () => {
  const { selected, ambient, selectedLink, ambientLink } = fixture();
  const before = readFileSync(ambient.workspaceConfig, 'utf8');
  vi.useFakeTimers();
  const job = service(selected).apply('1.2.3+main');
  // bound: checkout discovery uses bounded git children; wait for the product's job state.
  await vi.waitFor(() => expect(job.status).toBe('restarting'), { timeout: 20_000 });
  expect(readManifest('1.2.3+main', process.env, selected)?.checkout).toBe(selectedLink);
  expect(readFileSync(currentEntry(process.env, selected), 'utf8')).toBe(selectedLink);
  expect(readManifest('1.2.3+main', process.env, ambient)?.checkout).toBe(ambientLink);
  expect(readFileSync(ambient.workspaceConfig, 'utf8')).toBe(before);
});
