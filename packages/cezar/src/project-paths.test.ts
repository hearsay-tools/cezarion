import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, readRawConfig, readSkillsReposSync, updateConfigFile } from './config.ts';
import { testHome } from './home/test-home.testkit.ts';
import { dataReadDirs, projectPaths, readProjectPath } from './project-paths.ts';
import { ensureDataGitignore } from './data-gitignore.ts';
import { loadWorkflows } from './workflows/load.ts';
import { discoverSkills } from './skills.ts';
import { loadSessionContextRules } from './session-context.ts';
import { readProjectUiStateSync, writeProjectUiState } from './ui-state.ts';

describe('project directory reads before P5', () => {
  let repo: string;
  beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'project-paths-')); });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));
  function seed(root: 'cezar' | 'squawk', file: string, text: string) {
    const path = join(repo, '.ai', root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  }

  it('reads neither directory without creating either one', async () => {
    expect((await loadConfig(repo, testHome())).baseBranch).toBeUndefined();
    expect((await loadWorkflows(repo)).workflows.map(w => w.name)).toEqual(['quick-task']);
    expect(loadSessionContextRules(repo)).toEqual({ rules: [], reports: [] });
    expect(readProjectUiStateSync(repo)).toEqual({});
    expect(existsSync(join(repo, '.ai'))).toBe(false);
    expect(dataReadDirs(join(repo, 'custom'))).toEqual([join(repo, 'custom')]);
  });

  it.each(['cezar', 'squawk'] as const)('reads singleton files from %s alone', async root => {
    seed(root, 'config.json', JSON.stringify({ baseBranch: root, skillsRepos: [{ repo: 'team/skills' }] }));
    seed(root, 'context.yaml', 'version: 1\nrules: []\n');
    seed(root, 'ui-state.json', '{"disabledTeamSkills":[{"repo":"team/skills","name":"ship"}]}');
    expect((await loadConfig(repo, testHome())).baseBranch).toBe(root);
    expect(readSkillsReposSync(repo)[0]?.repo).toBe('team/skills');
    expect((await readRawConfig(projectPaths(repo).write)).ok).toBe(true);
    expect(loadSessionContextRules(repo)).toEqual({ rules: [], reports: [] });
    expect(readProjectUiStateSync(repo).disabledTeamSkills).toHaveLength(1);
    if (root === 'squawk') expect(existsSync(projectPaths(repo).write)).toBe(false);
  });

  it('uses whole legacy files, including damaged files, before fallback', async () => {
    seed('squawk', 'config.json', '{"baseBranch":"fallback"}');
    const legacy = seed('cezar', 'config.json', '{"defaultRunner":"codex"}');
    expect((await loadConfig(repo, testHome())).baseBranch).toBeUndefined();
    writeFileSync(legacy, '{broken');
    expect(readProjectPath(repo, 'config.json')).toBe(legacy);
    expect((await readRawConfig(projectPaths(repo).write)).ok).toBe(false);
    expect((await loadConfig(repo, testHome())).baseBranch).toBeUndefined();
  });

  it('preserves fallback config and preferences when writing legacy counterparts', async () => {
    const fallback = seed('squawk', 'config.json', '{"baseBranch":"fallback","unknown":7}');
    seed('squawk', 'ui-state.json', '{"openFiles":["a.ts"]}');
    await updateConfigFile(projectPaths(repo).write, current => {
      if (!current.ok) throw new Error(current.issue);
      return { write: { ...current.raw, defaultRunner: 'codex' }, result: true };
    });
    expect(JSON.parse(readFileSync(join(projectPaths(repo).write, 'config.json'), 'utf8'))).toEqual({ baseBranch: 'fallback', unknown: 7, defaultRunner: 'codex' });
    expect(readFileSync(fallback, 'utf8')).toBe('{"baseBranch":"fallback","unknown":7}');
    await writeProjectUiState(repo, { ...readProjectUiStateSync(repo), focusedFile: 'a.ts' });
    expect(readProjectUiStateSync(repo)).toEqual({ openFiles: ['a.ts'], focusedFile: 'a.ts' });
  });

  it('unions workflow and skill names with legacy precedence', async () => {
    for (const root of ['cezar', 'squawk'] as const) {
      seed(root, 'workflows/shared.yaml', `name: shared\ndescription: ${root}\nsteps:\n  - id: task\n    prompt: test\n`);
      seed(root, `workflows/${root}.yaml`, `name: ${root}\nsteps:\n  - id: task\n    prompt: test\n`);
      seed(root, 'skills/shared.md', `---\nname: shared\n---\n${root}`);
      seed(root, `skills/${root}.md`, root);
    }
    const workflows = (await loadWorkflows(repo)).workflows;
    expect(workflows.map(w => w.name)).toEqual(['cezar', 'quick-task', 'shared', 'squawk']);
    expect(workflows.find(w => w.name === 'shared')?.description).toBe('cezar');
    const skills = await discoverSkills(repo, {}, testHome());
    expect(skills.map(s => s.name)).toEqual(['cezar', 'shared', 'squawk']);
    expect(skills.find(s => s.name === 'shared')?.body).toBe('cezar');
  });

  it('adds fallback ignore rules without creating the fallback directory', () => {
    ensureDataGitignore(repo);
    expect(existsSync(join(repo, '.ai', 'squawk'))).toBe(false);
    const shared = readFileSync(join(repo, '.ai', '.gitignore'), 'utf8');
    expect(shared).toContain('/squawk/runs.db-wal\n');
    expect(shared).toContain('/squawk/runs/\n');
    expect(shared).toContain('/squawk-migration.json\n');
    expect(shared).not.toContain('/squawk/workflows');
    ensureDataGitignore(repo);
    expect(readFileSync(join(repo, '.ai', '.gitignore'), 'utf8')).toBe(shared);
  });
});
