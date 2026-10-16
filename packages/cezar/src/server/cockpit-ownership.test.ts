import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CockpitOwnership } from './cockpit-ownership.ts';
import { ProjectContexts } from './project-context.ts';
import { processStartToken } from '../delegation/process-liveness.ts';
import { seedRuns } from '../runs/run-store.testkit.ts';

const roots: string[] = [];
const owners: CockpitOwnership[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cez-owner-unit-'));
  roots.push(root);
  const owner = new CockpitOwnership();
  owners.push(owner);
  return { root, owner, dataDir: join(root, '.ai/cezar') };
}
afterEach(() => {
  for (const owner of owners.splice(0)) owner.releaseAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('canonicalizes data-directory aliases, publishes URLs, and allows reacquisition after exit cleanup', async () => {
  const { root, owner, dataDir } = fixture();
  await owner.acquire(dataDir);
  owner.publishUrl('http://127.0.0.1:4321');
  const alias = join(root, 'alias');
  symlinkSync(dataDir, alias, 'dir');
  await owner.acquire(alias); // the same process can reuse its claim
  const contender = fixture().owner;
  await expect(contender.acquire(alias)).rejects.toThrow('http://127.0.0.1:4321');
  owner.releaseAll();
  await contender.acquire(alias);
  contender.publishUrl('http://127.0.0.1:4322');
  owner.releaseAll(); // delayed cleanup cannot remove the new owner
  await expect(owner.acquire(dataDir)).rejects.toThrow('http://127.0.0.1:4322');
});

it('recovers a dead owner and an interrupted reclamation without an age timeout', async () => {
  const { owner, dataDir } = fixture();
  mkdirSync(dataDir, { recursive: true });
  const child = spawnSync(process.execPath, ['-e', ''], { timeout: 5_000 });
  expect(child.status).toBe(0);
  const dead = () => JSON.stringify({ pid: child.pid, token: randomUUID() });
  writeFileSync(join(dataDir, 'cockpit.lock'), dead());
  writeFileSync(join(dataDir, 'cockpit.lock.reclaim'), dead());
  await owner.acquire(dataDir);
  owner.publishUrl('http://127.0.0.1:4321');
  await expect(fixture().owner.acquire(dataDir)).rejects.toThrow('http://127.0.0.1:4321');
});

it('waits for a competing startup to publish its bound URL', async () => {
  const { owner, dataDir } = fixture();
  await owner.acquire(dataDir);
  const waiting = expect(fixture().owner.acquire(dataDir)).rejects.toThrow('http://127.0.0.1:54321');
  owner.publishUrl('http://127.0.0.1:54321');
  await waiting;
});

it('refuses a secondary project before its store opens or recovery runs', async () => {
  const { root, owner, dataDir } = fixture();
  await owner.acquire(dataDir);
  owner.publishUrl('http://127.0.0.1:4321');
  const contexts = new ProjectContexts({
    ownership: fixture().owner,
    listProjects: async () => [{ id: 'busy', root, status: 'ok' }],
  });
  await expect(contexts.context('busy')).rejects.toThrow('http://127.0.0.1:4321');
  expect(existsSync(join(dataDir, 'runs'))).toBe(false);
  expect(contexts.ids()).toEqual([]);
});

it('secondary ownership lasts until process exit, even after context disposal', async () => {
  const { root, owner, dataDir } = fixture();
  owner.publishUrl('http://127.0.0.1:4321');
  const contexts = new ProjectContexts({
    ownership: owner,
    listProjects: async () => [{ id: 'secondary', root, status: 'not-git' }],
  });
  await contexts.context('secondary');
  contexts.disposeAll();
  const record = JSON.parse(readFileSync(join(dataDir, 'cockpit.lock'), 'utf8'));
  expect(record.url).toBe('http://127.0.0.1:4321');
  await expect(fixture().owner.acquire(dataDir)).rejects.toThrow('http://127.0.0.1:4321');
});

it.each([false, true])('releases a cold maintenance claim without releasing the boot project (work fails: %s)', async (fails) => {
  const { root, owner, dataDir } = fixture();
  const boot = fixture();
  await owner.acquire(boot.dataDir);
  owner.publishUrl('http://127.0.0.1:4321');
  const bootClaim = readFileSync(join(boot.dataDir, 'cockpit.lock'), 'utf8');
  seedRuns(dataDir, []);
  const contexts = new ProjectContexts({
    ownership: owner,
    listProjects: async () => [{ id: 'cold', root, status: 'not-git' }],
  });
  try {
    const maintenance = contexts.withMaintenanceStore('cold', async () => {
      expect(existsSync(join(dataDir, 'cockpit.lock'))).toBe(true);
      if (fails) throw new Error('maintenance failed');
    });
    if (fails) await expect(maintenance).rejects.toThrow('maintenance failed');
    else await maintenance;
    expect(contexts.ids()).toEqual([]);
    expect(existsSync(join(dataDir, 'cockpit.lock'))).toBe(false);
    expect(readFileSync(join(boot.dataDir, 'cockpit.lock'), 'utf8')).toBe(bootClaim);
    await fixture().owner.acquire(dataDir);
  } finally {
    contexts.disposeAll();
  }
});

it('borrows a pre-existing process claim for maintenance without releasing it', async () => {
  const { root, owner, dataDir } = fixture();
  seedRuns(dataDir, []);
  await owner.acquire(dataDir);
  owner.publishUrl('http://127.0.0.1:4321');
  const claim = readFileSync(join(dataDir, 'cockpit.lock'), 'utf8');
  const contexts = new ProjectContexts({
    ownership: owner,
    listProjects: async () => [{ id: 'cold', root, status: 'not-git' }],
  });
  try {
    await contexts.withMaintenanceStore('cold', async () => undefined);
    expect(readFileSync(join(dataDir, 'cockpit.lock'), 'utf8')).toBe(claim);
    await expect(fixture().owner.acquire(dataDir)).rejects.toThrow('http://127.0.0.1:4321');
  } finally {
    contexts.disposeAll();
  }
});

it.runIf(process.platform === 'linux' || process.platform === 'darwin')('reclaims a stale process incarnation even when its PID is live again', async () => {
  const { owner, dataDir } = fixture();
  mkdirSync(dataDir, { recursive: true });
  const startToken = processStartToken(process.pid);
  expect(startToken).toBeTruthy();
  const previous = { pid: process.pid, token: randomUUID(), startToken: `${startToken}0`, url: 'http://127.0.0.1:11111' };
  writeFileSync(join(dataDir, 'cockpit.lock'), JSON.stringify(previous));
  writeFileSync(join(dataDir, 'cockpit.lock.reclaim'), JSON.stringify({ ...previous, token: randomUUID() }));
  await owner.acquire(dataDir);
  owner.publishUrl('http://127.0.0.1:4321');
  await expect(fixture().owner.acquire(dataDir)).rejects.toThrow('http://127.0.0.1:4321');
});
