import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importableSkillSchema } from '@open-mercato/cezar-contract/skills';
import { workspaceUiStatePath } from './paths.ts';
import * as remote from './skills-remote.ts';
import {
  discoverSkills,
  filterDisabledTeamSkills,
  readDisabledTeamSkills,
  type Skill,
} from './skills.ts';

/**
 * The off-list's two pure halves. `readDisabledTeamSkills` parses a user-editable ui-state;
 * `filterDisabledTeamSkills` applies it by source repo and name. Pure, so they are testable
 * without a network clone.
 */

const A = 'acme/skills';
const B = 'other/skills';
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function teamSkill(name: string, repo: string): Skill {
  return {
    name,
    body: `${name} body`,
    path: `${repo}@main:${name}/SKILL.md`,
    source: 'team',
    team: { repo, ref: 'main', path: `${name}/SKILL.md`, dir: true },
  };
}

function localSkill(name: string): Skill {
  return { name, body: `${name} body`, path: `/repo/.ai/cezar/skills/${name}.md`, source: 'cezar' };
}

describe('readDisabledTeamSkills', () => {
  it('keeps only well-formed { repo, name } entries', () => {
    expect(
      readDisabledTeamSkills({
        disabledTeamSkills: [{ repo: A, name: 'x' }, 'x', { name: 'y' }, { repo: A, name: '' }, 3],
      }),
    ).toEqual([{ repo: A, name: 'x' }]);
  });

  it('reads a missing key as nothing switched off', () => {
    expect(readDisabledTeamSkills({})).toEqual([]);
  });

  it('reads a non-array as nothing switched off', () => {
    expect(readDisabledTeamSkills({ disabledTeamSkills: 'x' })).toEqual([]);
  });
});

describe('filterDisabledTeamSkills', () => {
  it('drops the skill from the named repo', () => {
    expect(filterDisabledTeamSkills([teamSkill('x', A)], [{ repo: A, name: 'x' }])).toEqual([]);
  });

  it('keeps the same name from another repo', () => {
    expect(filterDisabledTeamSkills([teamSkill('x', B)], [{ repo: A, name: 'x' }]).map((s) => s.team?.repo)).toEqual([B]);
  });

  it('never drops a local skill', () => {
    expect(filterDisabledTeamSkills([localSkill('x')], [{ repo: A, name: 'x' }]).map((s) => s.name)).toEqual(['x']);
  });

  it('keeps everything for an empty off-list', () => {
    const skills = [teamSkill('x', A), localSkill('y')];
    expect(filterDisabledTeamSkills(skills, [])).toEqual(skills);
  });
});

describe('discoverSkills team-skill off-list', () => {
  async function project(uiState?: Record<string, unknown>): Promise<string> {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cezar-skills-'));
    tempDirs.push(repoRoot);
    await mkdir(join(repoRoot, '.ai/cezar'), { recursive: true });
    if (uiState) await writeFile(join(repoRoot, '.ai/cezar/ui-state.json'), JSON.stringify(uiState));
    return repoRoot;
  }

  const teamNames = async (repoRoot: string) =>
    (await discoverSkills(repoRoot)).filter((skill) => skill.source === 'team').map((skill) => skill.name);

  // A home of its own: an inherited CEZ_HOME keeps a real workspace ui-state this must not touch.
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cezar-skills-home-'));
    vi.stubEnv('CEZ_HOME', home);
    vi.spyOn(remote, 'getTeamSkillsCached').mockReturnValue([teamSkill('x', A), teamSkill('y', A)]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('shows every team skill when nothing is switched off', async () => {
    expect(await teamNames(await project())).toEqual(['x', 'y']);
  });

  it('hides a switched-off skill', async () => {
    expect(await teamNames(await project({ disabledTeamSkills: [{ repo: A, name: 'x' }] }))).toEqual(['y']);
  });

  it('ignores the legacy importedSkills keys, project and workspace', async () => {
    await mkdir(dirname(workspaceUiStatePath()), { recursive: true });
    await writeFile(workspaceUiStatePath(), JSON.stringify({ importedSkills: ['nothing'] }));
    expect(await teamNames(await project({ importedSkills: [] }))).toEqual(['x', 'y']);
  });

  it('a junk off-list switches nothing off', async () => {
    expect(await teamNames(await project({ disabledTeamSkills: ['x', { name: 'x' }] }))).toEqual(['x', 'y']);
  });

  it('switching one source off lets the same name from another source win', async () => {
    vi.spyOn(remote, 'getTeamSkillsCached').mockReturnValue([teamSkill('x', A), teamSkill('x', B)]);
    const catalog = async (uiState?: Record<string, unknown>) =>
      (await discoverSkills(await project(uiState))).filter((skill) => skill.name === 'x');
    expect((await catalog()).map((s) => s.team?.repo)).toEqual([A]);
    expect((await catalog({ disabledTeamSkills: [{ repo: A, name: 'x' }] })).map((s) => s.team?.repo)).toEqual([B]);
  });

  it('the importable catalog carries the full skill, a description-less one included', () => {
    const skill = teamSkill('x', A);
    expect(importableSkillSchema.parse(skill)).toEqual(skill);
  });
});

describe('discoverSkills local entrypoints', () => {
  it('recognizes only scalar true as the interactive composer hint', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cezar-skills-'));
    tempDirs.push(repoRoot);
    const skillsDir = join(repoRoot, '.ai/cezar/skills');
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(skillsDir, 'true.md'), '---\r\ninteractive: "true"\r\n---\r\nBody');
    await writeFile(join(skillsDir, 'false.md'), '---\ninteractive: false\n---\nBody');
    await writeFile(join(skillsDir, 'array.md'), '---\ninteractive: [true]\n---\nBody');
    await writeFile(join(skillsDir, 'yes.md'), '---\ninteractive: yes\n---\nBody');
    await writeFile(join(skillsDir, 'missing.md'), 'Body');

    const skills = (await discoverSkills(repoRoot)).filter((skill) => skill.source === 'cezar');
    expect(skills.find((skill) => skill.name === 'true')).toMatchObject({
      interactive: true,
      body: 'Body',
    });
    for (const name of ['false', 'array', 'yes', 'missing']) {
      expect(skills.find((skill) => skill.name === name)?.interactive).toBeUndefined();
    }
  });

  it('keeps flat and SKILL.md skills while excluding nested reference files', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cezar-skills-'));
    tempDirs.push(repoRoot);
    const skillsDir = join(repoRoot, '.ai/cezar/skills');
    await mkdir(join(skillsDir, 'om-example/references'), { recursive: true });
    await mkdir(join(skillsDir, 'legacy/nested'), { recursive: true });
    await writeFile(join(skillsDir, 'flat.md'), '# Flat skill');
    await writeFile(join(skillsDir, 'legacy/nested/legacy.md'), '# Legacy skill');
    await writeFile(join(skillsDir, 'om-example/SKILL.md'), '# Example skill');
    await writeFile(join(skillsDir, 'om-example/references/agentic-setup.md'), '# Supporting doc');

    const skills = (await discoverSkills(repoRoot)).filter((skill) => skill.source === 'cezar');

    expect(skills.map((skill) => skill.name)).toEqual(['flat', 'legacy', 'om-example']);
    expect(skills.some((skill) => skill.name === 'agentic-setup')).toBe(false);
  });

  it('follows npx-skills directory mirrors and deduplicates them by skill name', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cezar-skills-'));
    tempDirs.push(repoRoot);
    const canonicalDir = join(repoRoot, '.agents/skills/om-example');
    const mirrorRoot = join(repoRoot, '.claude/skills');
    await mkdir(canonicalDir, { recursive: true });
    await mkdir(mirrorRoot, { recursive: true });
    await writeFile(join(canonicalDir, 'SKILL.md'), '# Example skill');
    await symlink('../../.agents/skills/om-example', join(mirrorRoot, 'om-example'), 'dir');

    const skills = (await discoverSkills(repoRoot)).filter((skill) => skill.name === 'om-example');

    expect(skills).toHaveLength(1);
    expect(skills[0]?.source).toBe('agents');
  });
});

/**
 * #366: `discoverSkills` used to merge the developer's real `~/.agents/skills` and
 * `~/.claude/skills` into every catalog read. Those are filesystem walks with no
 * spawn cost, but they make the unit suite machine-dependent — a laptop with
 * global skills sees them, CI (a bare home) does not. Gate the dirs the same way
 * #365 gates the vendor team source (`process.env.VITEST`), and plant fixtures
 * under a temp `$HOME` so `os.homedir()` still resolves them when the gate is off.
 */
describe('discoverSkills built-in skills (#774)', () => {
  const builtin = (name: string): Skill => ({ name, body: 'BUILT-IN', path: `builtin:${name}`, source: 'builtin' });

  it('appends built-ins after the sorted catalog and lets a discovered skill of the same name win', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cezar-skills-'));
    tempDirs.push(repoRoot);
    const skillsDir = join(repoRoot, '.ai/cezar/skills');
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(skillsDir, 'zz-last.md'), 'Body');
    await writeFile(join(skillsDir, 'shadowed.md'), 'REPO');

    const skills = (await discoverSkills(repoRoot, { builtin: [builtin('aa-first'), builtin('shadowed')] }))
      .filter((skill) => skill.source === 'cezar' || skill.source === 'builtin');
    expect(skills.map((skill) => `${skill.source}:${skill.name}`)).toEqual(['cezar:shadowed', 'cezar:zz-last', 'builtin:aa-first']);
    expect(skills.find((skill) => skill.name === 'shadowed')?.body).toBe('REPO');
  });

  it('lists no built-in when the caller passes none', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cezar-skills-'));
    tempDirs.push(repoRoot);
    expect((await discoverSkills(repoRoot)).some((skill) => skill.source === 'builtin')).toBe(false);
  });
});

describe('discoverSkills global dirs', () => {
  const planted = {
    agents: 'cez-vitest-global-agents',
    claude: 'cez-vitest-global-claude',
  };

  async function plantGlobalHome(): Promise<{ home: string; repoRoot: string; restore: () => void }> {
    const home = await mkdtemp(join(tmpdir(), 'cez-skills-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cez-skills-repo-'));
    tempDirs.push(home, repoRoot);
    await mkdir(join(home, '.agents/skills', planted.agents), { recursive: true });
    await mkdir(join(home, '.claude/skills', planted.claude), { recursive: true });
    await writeFile(join(home, '.agents/skills', planted.agents, 'SKILL.md'), '# Agents global');
    await writeFile(join(home, '.claude/skills', planted.claude, 'SKILL.md'), '# Claude global');
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    return {
      home,
      repoRoot,
      restore: () => {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      },
    };
  }

  it('does not merge the real (or planted) global skill dirs under vitest', async () => {
    const { home, repoRoot, restore } = await plantGlobalHome();
    try {
      expect(homedir()).toBe(home);
      const skills = await discoverSkills(repoRoot);
      expect(skills.find((skill) => skill.name === planted.agents)).toBeUndefined();
      expect(skills.find((skill) => skill.name === planted.claude)).toBeUndefined();
      expect(skills.filter((skill) => skill.source === 'global')).toEqual([]);
    } finally {
      restore();
    }
  });

  it('reads ~/.agents/skills and ~/.claude/skills outside vitest', async () => {
    const { home, repoRoot, restore } = await plantGlobalHome();
    const vitest = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(homedir()).toBe(home);
      const skills = (await discoverSkills(repoRoot)).filter((skill) => skill.source === 'global');
      expect(skills.map((skill) => skill.name).sort()).toEqual([planted.agents, planted.claude].sort());
    } finally {
      if (vitest !== undefined) process.env.VITEST = vitest;
      restore();
    }
  });
});
