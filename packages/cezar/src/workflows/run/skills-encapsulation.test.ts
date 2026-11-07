import { testHome } from '../../home/test-home.testkit.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { discoverSkills, type Skill } from '../../skills.ts';
import { RunStore } from '../../runs/store.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import { createActiveRun } from '../active-run.ts';
import { RunSkills } from './run-skills.ts';
import { TrackedWork } from './tracked-work.ts';

vi.mock('../../skills.ts', async (original) => ({
  ...await original<typeof import('../../skills.ts')>(), discoverSkills: vi.fn(),
}));
const unused = (): never => { throw new Error('unused skills collaborator'); };
let root: string;
let store: RunStore;
let owner: RunSkills;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-skill-owner-'));
  store = RunStore.open(root);
  owner = new RunSkills({ home: testHome(), store, repoRoot: root, dataDir: root, semaphore: new WorkspaceSemaphore({ home: testHome() }),
    work: new TrackedWork(), disposed: () => false }, {
    builtinSkills: () => [], workerExecutionStopped: unused, isCurrentState: unused, flushAgentInputs: unused,
  });
});
afterEach(() => { vi.mocked(discoverSkills).mockReset(); store.flush(); rmSync(root, { recursive: true, force: true }); });
const state = () => createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
const entry = (): Skill => ({ name: 'demo', body: 'first body', path: '/skills/demo', source: 'team',
  team: { repo: 'org/skills', ref: 'main', path: 'demo', dir: true, commit: 'first' } });

it('keeps stable catalog and nested views while shared skill values change', async () => {
  const shared = entry();
  vi.mocked(discoverSkills).mockResolvedValue([shared]);
  const run = state();
  await owner.loadRunSkills(run, 'throw');
  const catalog = run.skills.catalog!;
  const view = catalog[0]!;
  const team = view.team!;
  expect(owner.enabledSkills(run)[0]).toBe(view);
  expect(Object.isFrozen(shared)).toBe(false);
  expect(Object.isFrozen(shared.team)).toBe(false);
  shared.body = 'new body'; shared.path = '/files/current'; shared.source = 'builtin';
  shared.description = 'current'; shared.interactive = true;
  shared.team = { repo: 'new/repo', ref: 'next', path: 'new/path', dir: false, commit: 'next' };
  expect(run.skills.catalog).toBe(catalog);
  expect(catalog[0]).toBe(view);
  expect(view.team).toBe(team);
  expect(view.body).toBe('new body');
  expect(view.path).toBe('/files/current');
  expect(view.source).toBe('builtin');
  expect(view.description).toBe('current');
  expect(view.interactive).toBe(true);
  expect([team.repo, team.ref, team.path, team.dir, team.commit]).toEqual(['new/repo', 'next', 'new/path', false, 'next']);
});

it('refuses catalog, skill, team and slot writes while owner replacement still works', async () => {
  vi.mocked(discoverSkills).mockResolvedValue([entry()]);
  const run = state();
  await owner.loadRunSkills(run, 'throw');
  const catalog = run.skills.catalog!;
  for (const value of [run.skills, catalog, catalog[0]!, catalog[0]!.team!]) {
    expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.defineProperty(value, 'forged', { value: true })).toBe(false);
  }
  expect(Object.isFrozen(Object.getPrototypeOf(run.skills))).toBe(true);
  const assign = (target: object, key: string, value: unknown) => Object.assign(target, { [key]: value });
  expect(() => assign(run, 'skills', state().skills)).toThrow(TypeError);
  expect(() => assign(catalog[0]!, 'body', 'forged')).toThrow(TypeError);
  expect(() => assign(catalog[0]!.team!, 'repo', 'forged')).toThrow(TypeError);
  expect(() => Array.prototype.push.call(catalog, entry())).toThrow(TypeError);
  expect(() => Array.prototype.splice.call(catalog, 0, 1)).toThrow(TypeError);
  vi.mocked(discoverSkills).mockResolvedValue([{ ...entry(), body: 'replacement' }]);
  await owner.loadRunSkills(run, 'throw');
  expect(run.skills.catalog).not.toBe(catalog);
  expect(run.skills.catalog![0]!.body).toBe('replacement');
  expect(catalog[0]!.body).toBe('first body');
  expect(state().skills.catalog).toBeUndefined();
});

it('keeps discovery failure policy and synchronous throw behavior', async () => {
  const run = state();
  vi.mocked(discoverSkills).mockResolvedValue([entry()]);
  await owner.loadRunSkills(run, 'throw');
  const catalog = run.skills.catalog;
  vi.mocked(discoverSkills).mockRejectedValue(new Error('discovery'));
  await owner.loadRunSkills(run, 'ignore');
  expect(run.skills.catalog).toBe(catalog);
  await expect(owner.loadRunSkills(run, 'throw')).rejects.toThrow('discovery');
  vi.mocked(discoverSkills).mockImplementation(() => { throw new Error('synchronous'); });
  await expect(owner.loadRunSkills(run, 'ignore')).rejects.toThrow('synchronous');
  expect(run.skills.catalog).toBe(catalog);
});
