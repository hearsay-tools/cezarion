import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importableSkillSchema } from '@open-mercato/cezar-contract/skills';
import * as config from './config.ts';
import { workspaceUiStatePath } from './paths.ts';
import * as remote from './skills-remote.ts';
import {
  discoverSkills,
  filterImportedTeamSkills,
  readImportedSkills,
  type Skill,
} from './skills.ts';

/**
 * The opt-out gate's two pure halves (#391 follow-up: the promo banner is gone, replaced by
 * per-skill curation). `readImportedSkills` parses a user-editable ui-state as a tri-state
 * (absent = not curated = keep all); `filterImportedTeamSkills` applies the gate. Kept pure so
 * they are testable without a network clone — the gated repo set is otherwise a vendor default.
 */

const OM = 'open-mercato/skills';
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

describe('readImportedSkills', () => {
  it('returns the string names from a well-formed array', () => {
    expect(readImportedSkills({ importedSkills: ['pr-create', 'code-review'] })).toEqual([
      'pr-create',
      'code-review',
    ]);
  });

  it('returns undefined for a missing key — not curated, so the caller keeps all', () => {
    expect(readImportedSkills({})).toBeUndefined();
  });

  it('returns undefined for a non-array (a hand-edited file) — the safe, keep-all reading', () => {
    expect(readImportedSkills({ importedSkills: 'pr-create' })).toBeUndefined();
  });

  it('distinguishes an explicit empty array (curated to nothing) from absent', () => {
    expect(readImportedSkills({ importedSkills: [] })).toEqual([]);
  });

  it('drops non-string and empty entries rather than throwing', () => {
    expect(readImportedSkills({ importedSkills: ['ok', 42, '', null, 'fine'] })).toEqual(['ok', 'fine']);
  });
});

describe('filterImportedTeamSkills', () => {
  const gated = new Set([OM]);

  it('keeps every gated-repo skill when not curated (undefined) — opt-out default, no upgrade break', () => {
    const skills = [teamSkill('pr-create', OM), teamSkill('code-review', OM)];
    expect(filterImportedTeamSkills(skills, gated, undefined).map((s) => s.name)).toEqual([
      'pr-create',
      'code-review',
    ]);
  });

  it('drops a gated-repo skill once curated away (explicit empty array)', () => {
    const skills = [teamSkill('pr-create', OM), teamSkill('code-review', OM)];
    expect(filterImportedTeamSkills(skills, gated, []).map((s) => s.name)).toEqual([]);
  });

  it('keeps only the named skills from a gated repo when curated', () => {
    const skills = [teamSkill('pr-create', OM), teamSkill('code-review', OM)];
    expect(filterImportedTeamSkills(skills, gated, ['code-review']).map((s) => s.name)).toEqual([
      'code-review',
    ]);
  });

  it('keeps every skill from a repo that is not gated (custom team repo auto-loads)', () => {
    const skills = [teamSkill('alpha', 'acme/team-skills'), teamSkill('beta', 'acme/team-skills')];
    expect(filterImportedTeamSkills(skills, gated, []).map((s) => s.name)).toEqual(['alpha', 'beta']);
  });

  it('never gates a local skill (no team field), even when curated to nothing', () => {
    const skills = [localSkill('house-rules'), teamSkill('pr-create', OM)];
    expect(filterImportedTeamSkills(skills, gated, []).map((s) => s.name)).toEqual(['house-rules']);
  });

  it('gates nothing when the gated set is empty (repo configured its own skillsRepos)', () => {
    const skills = [teamSkill('pr-create', OM)];
    expect(filterImportedTeamSkills(skills, new Set(), []).map((s) => s.name)).toEqual(['pr-create']);
  });
});

/**
 * hearsay-tools/cezarion#1408 (port of upstream open-mercato/cezar#1082): the default-skill
 * selection lives in each project's `.ai/cezar/ui-state.json`. The old workspace value only seeds
 * a project that has no selection of its own.
 */
describe('discoverSkills default-skill selection per project (#1408)', () => {
  const teamNames = async (repoRoot: string) =>
    (await discoverSkills(repoRoot)).filter((skill) => skill.source === 'team').map((skill) => skill.name);

  async function project(importedSkills?: string[]): Promise<string> {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cezar-skills-'));
    tempDirs.push(repoRoot);
    await mkdir(join(repoRoot, '.ai/cezar'), { recursive: true });
    if (importedSkills) await writeFile(join(repoRoot, '.ai/cezar/ui-state.json'), JSON.stringify({ importedSkills }));
    return repoRoot;
  }

  async function workspaceSelection(importedSkills: string[]): Promise<void> {
    await mkdir(dirname(workspaceUiStatePath()), { recursive: true });
    await writeFile(workspaceUiStatePath(), JSON.stringify({ importedSkills }));
  }

  // A home of its own: an inherited CEZ_HOME keeps a real workspace ui-state this must not touch.
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cezar-skills-home-'));
    vi.stubEnv('CEZ_HOME', home);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  function offerDefaults(): void {
    vi.spyOn(remote, 'getTeamSkillsCached').mockReturnValue([teamSkill('om-fix', OM), teamSkill('om-review', OM)]);
    vi.spyOn(config, 'gatedSkillsRepos').mockResolvedValue(new Set([OM]));
  }

  it('an empty project selection hides every default skill, even when the workspace lists them', async () => {
    offerDefaults();
    await workspaceSelection(['om-fix', 'om-review']);
    expect(await teamNames(await project([]))).toEqual([]);
  });

  it('keeps a separate selection for each project', async () => {
    offerDefaults();
    const first = await project(['om-fix']);
    const second = await project(['om-review']);
    expect(await teamNames(first)).toEqual(['om-fix']);
    expect(await teamNames(second)).toEqual(['om-review']);
  });

  it('a project with no selection keeps the legacy workspace selection', async () => {
    offerDefaults();
    await workspaceSelection(['om-review']);
    expect(await teamNames(await project())).toEqual(['om-review']);
  });

  it('the importable catalog carries the full skill, a description-less one included', () => {
    const skill = teamSkill('om-fix', OM);
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
