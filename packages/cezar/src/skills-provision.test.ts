import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Skill } from './skills.ts';
import {
  MAX_SKILL_CLOSURE,
  PROVISION_IGNORE_MARK,
  mentionsSkill,
  provisionSkills,
  removeProvisionedSkills,
  skillClosure,
} from './skills-provision.ts';
import { seedTeamDirSkillClone } from './skills-remote.testkit.ts';

const execFileAsync = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const AGENT_DIRS = ['.claude', '.agents', '.cursor'];

function skill(name: string, body = '', source: Skill['source'] = 'ai'): Skill {
  return { name, body, path: `/skills/${name}/SKILL.md`, source };
}

describe('mentionsSkill', () => {
  it('matches a hyphenated name as a whole word', () => {
    expect(mentionsSkill('run om-code-review now', 'om-code-review')).toBe(true);
    expect(mentionsSkill('run om-code-reviewer now', 'om-code-review')).toBe(false);
    expect(mentionsSkill('see x-om-code-review', 'om-code-review')).toBe(false);
  });

  it('matches a plain name only as /name or `name`', () => {
    expect(mentionsSkill('then run /fix on it', 'fix')).toBe(true);
    expect(mentionsSkill('then run `fix` on it', 'fix')).toBe(true);
    expect(mentionsSkill('fix the bug', 'fix')).toBe(false);
  });
});

describe('skillClosure', () => {
  it('lists the roots first, then every skill they name, transitively', () => {
    const a = skill('lead-a', 'then run helper-b');
    const b = skill('helper-b', 'finish with helper-c');
    const c = skill('helper-c');
    const unrelated = skill('other-d');
    expect(skillClosure([a], [unrelated, c, b, a]).skills.map((s) => s.name)).toEqual(['lead-a', 'helper-b', 'helper-c']);
  });

  it('stops on a cycle', () => {
    const a = skill('lead-a', 'run helper-b');
    const b = skill('helper-b', 'back to lead-a');
    expect(skillClosure([a], [a, b]).skills.map((s) => s.name)).toEqual(['lead-a', 'helper-b']);
  });

  it('takes the first catalog entry for a name, so local skills win', () => {
    const local = skill('helper-b', 'LOCAL', 'ai');
    const team = skill('helper-b', 'TEAM', 'team');
    const [, found] = skillClosure([skill('lead-a', 'run helper-b')], [local, team]).skills;
    expect(found?.body).toBe('LOCAL');
  });

  it('caps the closure and names the first skill it left out', () => {
    const chain = Array.from({ length: 30 }, (_, i) => skill(`step-${i}`, i < 29 ? `next step-${i + 1}` : ''));
    const result = skillClosure([chain[0]!], chain);
    expect(MAX_SKILL_CLOSURE).toBe(24);
    expect(result.skills).toHaveLength(24);
    expect(result.truncated).toBe('step-24');
  });

  it('reports no truncation when the closure fits', () => {
    expect(skillClosure([skill('lead-a')], []).truncated).toBeUndefined();
  });
});

describe('provisionSkills', { timeout: 30_000 }, () => {
  let main: string;
  let worktree: string;
  let home: string;
  let lead: Skill;
  let helper: Skill;

  async function git(cwd: string, ...args: string[]): Promise<string> {
    return (await execFileAsync('git', args, { cwd })).stdout;
  }

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-provision-home-'));
    vi.stubEnv('HOME', home);
    main = realpathSync(mkdtempSync(join(tmpdir(), 'cez-provision-main-')));
    await git(main, 'init', '-q', '-b', 'main');
    writeFileSync(join(main, 'a.txt'), 'one\n');
    await git(main, 'add', '-A');
    await git(main, ...GIT_ID, 'commit', '-q', '-m', 'base');
    worktree = join(main, '.wt');
    await git(main, 'worktree', 'add', '-q', '-b', 'task', worktree);
    // `.wt` is the worktree itself: keep it out of the main checkout's status.
    writeFileSync(join(main, '.git', 'info', 'exclude'), '/.wt\n');
    const leadDir = join(home, 'skills-src', 'lead-skill');
    mkdirSync(join(leadDir, 'references'), { recursive: true });
    writeFileSync(join(leadDir, 'SKILL.md'), '---\nname: lead-skill\n---\nthen run helper-skill\n');
    writeFileSync(join(leadDir, 'references', 'notes.txt'), 'notes\n');
    lead = { name: 'lead-skill', body: 'then run helper-skill', path: join(leadDir, 'SKILL.md'), source: 'global' };
    const helperFile = join(home, 'skills-src', 'helper-skill.md');
    writeFileSync(helperFile, 'HELPER-BODY\n');
    helper = { name: 'helper-skill', description: 'Helps.', body: 'HELPER-BODY', path: helperFile, source: 'global' };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(main, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const manifestPath = async () => join((await git(worktree, 'rev-parse', '--absolute-git-dir')).trim(), 'cezar-skills.json');
  const status = (cwd: string) => git(cwd, 'status', '--porcelain', '--untracked-files=all');

  it('links a local directory skill and its single-file companion into all three dirs', async () => {
    const mainStatus = await status(main);
    const result = await provisionSkills(worktree, [lead], [lead, helper]);
    expect(result.installed).toEqual(['lead-skill', 'helper-skill']);
    for (const dir of AGENT_DIRS) {
      const leadDest = join(worktree, dir, 'skills', 'lead-skill');
      expect(lstatSync(leadDest).isSymbolicLink()).toBe(true);
      expect(readlinkSync(leadDest)).toBe(join(home, 'skills-src', 'lead-skill'));
      expect(readlinkSync(join(worktree, dir, 'skills', 'helper-skill', 'SKILL.md'))).toBe(helper.path);
    }
    expect(await status(worktree)).toBe('');
    expect(await status(main)).toBe(mainStatus);
  });

  it('writes a generated SKILL.md for a built-in skill', async () => {
    const builtin: Skill = { name: 'auto-skill', description: 'Built in.', body: 'BUILTIN-BODY', path: 'builtin:auto-skill', source: 'builtin' };
    await provisionSkills(worktree, [builtin], [builtin]);
    const text = readFileSync(join(worktree, '.agents', 'skills', 'auto-skill', 'SKILL.md'), 'utf8');
    expect(text).toBe('---\nname: "auto-skill"\ndescription: "Built in."\n---\n\nBUILTIN-BODY\n');
  });

  it('materializes a team directory skill as a marked copy', async () => {
    const repo = 'org-provision/skills';
    const seeded = await seedTeamDirSkillClone(repo, 'team-skill', { 'SKILL.md': 'TEAM-BODY\n', 'references/r.md': 'ref\n' });
    try {
      const team: Skill = {
        name: 'team-skill', body: 'TEAM-BODY', path: `${repo}@main:skills/team-skill/SKILL.md`, source: 'team',
        team: { repo, ref: 'main', path: 'skills/team-skill/SKILL.md', dir: true, commit: seeded.commit },
      };
      const result = await provisionSkills(worktree, [team], [team]);
      expect(result.installed).toEqual(['team-skill']);
      expect(result.teamCopies['team-skill']).toHaveLength(3);
      expect(readFileSync(join(worktree, '.claude', 'skills', 'team-skill', 'references', 'r.md'), 'utf8')).toBe('ref\n');
      expect(await status(worktree)).toBe('');
    } finally {
      rmSync(seeded.sourceDir, { recursive: true, force: true });
    }
  });

  it('never touches an existing tracked entry', async () => {
    mkdirSync(join(worktree, '.agents', 'skills', 'lead-skill'), { recursive: true });
    writeFileSync(join(worktree, '.agents', 'skills', 'lead-skill', 'SKILL.md'), 'TRACKED\n');
    await git(worktree, 'add', '-A');
    await git(worktree, ...GIT_ID, 'commit', '-q', '-m', 'tracked skill');
    await provisionSkills(worktree, [lead], [lead]);
    expect(readFileSync(join(worktree, '.agents', 'skills', 'lead-skill', 'SKILL.md'), 'utf8')).toBe('TRACKED\n');
    expect(lstatSync(join(worktree, '.agents', 'skills', 'lead-skill')).isSymbolicLink()).toBe(false);
    expect(await status(worktree)).toBe('');
  });

  it('rejects an unsafe skill name', async () => {
    const bad: Skill = { ...helper, name: '../escape' };
    expect((await provisionSkills(worktree, [bad], [bad])).installed).toEqual([]);
    expect(existsSync(join(worktree, '.agents'))).toBe(false);
  });

  it('skips a skills dir that links out of the worktree', async () => {
    mkdirSync(join(main, 'outside-claude'), { recursive: true });
    symlinkSync(join(main, 'outside-claude'), join(worktree, '.claude'));
    const result = await provisionSkills(worktree, [lead], [lead]);
    expect(result.installed).toEqual(['lead-skill']);
    expect(existsSync(join(main, 'outside-claude', 'skills'))).toBe(false);
    expect(lstatSync(join(worktree, '.agents', 'skills', 'lead-skill')).isSymbolicLink()).toBe(true);
    const manifest = JSON.parse(readFileSync(await manifestPath(), 'utf8')) as { entries: Array<{ path: string }> };
    expect(manifest.entries.some((entry) => entry.path.startsWith('.claude/'))).toBe(false);
  });

  it('writes the owned .gitignore with the marker line', async () => {
    await provisionSkills(worktree, [lead], [lead, helper]);
    expect(readFileSync(join(worktree, '.agents', 'skills', '.gitignore'), 'utf8'))
      .toBe(`${PROVISION_IGNORE_MARK}\n/.gitignore\n/helper-skill\n/lead-skill\n`);
  });

  it('falls back to info/exclude when the repo owns the .gitignore', async () => {
    mkdirSync(join(worktree, '.agents', 'skills'), { recursive: true });
    writeFileSync(join(worktree, '.agents', 'skills', '.gitignore'), '# repo rules\n*.tmp\n');
    await git(worktree, 'add', '-A');
    await git(worktree, ...GIT_ID, 'commit', '-q', '-m', 'repo gitignore');
    await provisionSkills(worktree, [lead], [lead]);
    expect(readFileSync(join(worktree, '.agents', 'skills', '.gitignore'), 'utf8')).toBe('# repo rules\n*.tmp\n');
    expect(readFileSync(join(main, '.git', 'info', 'exclude'), 'utf8').split('\n')).toContain('.agents/skills/lead-skill');
    expect(await status(worktree)).toBe('');
  });

  it('never hides an untracked skill the user already has at a planned name', async () => {
    mkdirSync(join(worktree, '.agents', 'skills'), { recursive: true });
    writeFileSync(join(worktree, '.agents', 'skills', '.gitignore'), '# repo rules\n*.tmp\n');
    await git(worktree, 'add', '-A');
    await git(worktree, ...GIT_ID, 'commit', '-q', '-m', 'repo gitignore');
    const mine = join(worktree, '.agents', 'skills', 'lead-skill');
    mkdirSync(mine);
    writeFileSync(join(mine, 'SKILL.md'), 'MINE\n');
    await provisionSkills(worktree, [lead], [lead]);
    expect(readFileSync(join(mine, 'SKILL.md'), 'utf8')).toBe('MINE\n');
    expect(await status(worktree)).toContain('.agents/skills/lead-skill/SKILL.md');
  });

  it('records every entry in the worktree git dir, nothing in the working tree or a link target', async () => {
    await provisionSkills(worktree, [lead], [lead, helper]);
    const manifest = JSON.parse(readFileSync(await manifestPath(), 'utf8')) as {
      version: number; roots: string[]; entries: Array<{ path: string; kind: string }>;
    };
    expect(manifest.version).toBe(1);
    expect(manifest.roots).toEqual(['lead-skill']);
    expect(manifest.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      '.agents/skills/lead-skill', '.agents/skills/helper-skill', '.agents/skills/.gitignore',
    ]));
    expect(existsSync(join(home, 'skills-src', 'lead-skill', '.cezar-team-skill.json'))).toBe(false);
    expect((await status(worktree))).toBe('');
  });

  it('keeps a root from an earlier pass and its companions', async () => {
    await provisionSkills(worktree, [lead], [lead, helper]);
    await provisionSkills(worktree, [], [lead, helper]);
    expect(existsSync(join(worktree, '.agents', 'skills', 'helper-skill'))).toBe(true);
  });

  it('removes an owned entry whose skill left the closure', async () => {
    await provisionSkills(worktree, [lead], [lead, helper]);
    const plainLead: Skill = { ...lead, body: 'no companions now' };
    await provisionSkills(worktree, [], [plainLead, helper]);
    expect(existsSync(join(worktree, '.agents', 'skills', 'helper-skill'))).toBe(false);
    expect(readFileSync(join(worktree, '.agents', 'skills', '.gitignore'), 'utf8'))
      .toBe(`${PROVISION_IGNORE_MARK}\n/.gitignore\n/lead-skill\n`);
  });

  it('rewrites a link whose source moved', async () => {
    await provisionSkills(worktree, [lead], [lead]);
    const movedDir = join(home, 'moved', 'lead-skill');
    mkdirSync(movedDir, { recursive: true });
    writeFileSync(join(movedDir, 'SKILL.md'), 'moved\n');
    const moved: Skill = { ...lead, path: join(movedDir, 'SKILL.md') };
    const result = await provisionSkills(worktree, [], [moved]);
    expect(result.installed).toEqual(['lead-skill']);
    expect(readlinkSync(join(worktree, '.agents', 'skills', 'lead-skill'))).toBe(movedDir);
  });

  it('keeps a user-replaced entry and drops its record', async () => {
    await provisionSkills(worktree, [lead], [lead]);
    const dest = join(worktree, '.agents', 'skills', 'lead-skill');
    rmSync(dest);
    mkdirSync(dest);
    writeFileSync(join(dest, 'SKILL.md'), 'MINE\n');
    await provisionSkills(worktree, [], [{ ...lead, body: 'changed' }]);
    await removeProvisionedSkills(worktree);
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toBe('MINE\n');
    expect(existsSync(join(worktree, '.claude', 'skills', 'lead-skill'))).toBe(false);
  });

  it('removeProvisionedSkills removes owned entries and owned ignore files only', async () => {
    mkdirSync(join(worktree, '.claude', 'skills', 'mine'), { recursive: true });
    writeFileSync(join(worktree, '.claude', 'skills', 'mine', 'SKILL.md'), 'mine\n');
    await provisionSkills(worktree, [lead], [lead, helper]);
    await removeProvisionedSkills(worktree);
    for (const dir of AGENT_DIRS) {
      expect(existsSync(join(worktree, dir, 'skills', 'lead-skill'))).toBe(false);
      expect(existsSync(join(worktree, dir, 'skills', 'helper-skill'))).toBe(false);
      expect(existsSync(join(worktree, dir, 'skills', '.gitignore'))).toBe(false);
    }
    expect(readFileSync(join(worktree, '.claude', 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe('mine\n');
    expect(existsSync(join(home, 'skills-src', 'lead-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(await manifestPath())).toBe(false);
  });

  it('falls back to a copy when a link cannot be made', async () => {
    const refuse = async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
    await provisionSkills(worktree, [lead], [lead, helper], { symlink: refuse });
    const dest = join(worktree, '.agents', 'skills', 'lead-skill');
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dest, 'references', 'notes.txt'), 'utf8')).toBe('notes\n');
    expect(readFileSync(join(worktree, '.agents', 'skills', 'helper-skill', 'SKILL.md'), 'utf8')).toBe('HELPER-BODY\n');
    await removeProvisionedSkills(worktree);
    expect(existsSync(dest)).toBe(false);
  });

  // Final review of hearsay-tools/cezarion#1408: boundaries the first tests left open.
  const seedTeam = async (name: string) => {
    const repo = `org-provision/${name}`;
    const seeded = await seedTeamDirSkillClone(repo, name, { 'SKILL.md': 'TEAM-BODY\n', 'references/r.md': 'ref\n' });
    const team: Skill = {
      name, body: 'TEAM-BODY', path: `${repo}@main:skills/${name}/SKILL.md`, source: 'team',
      team: { repo, ref: 'main', path: `skills/${name}/SKILL.md`, dir: true, commit: seeded.commit },
    };
    return { team, cleanup: () => rmSync(seeded.sourceDir, { recursive: true, force: true }) };
  };

  it('never writes a team skill into a directory the user owns', async () => {
    const { team, cleanup } = await seedTeam('team-mine');
    try {
      const mine = join(worktree, '.agents', 'skills', 'team-mine');
      mkdirSync(mine, { recursive: true });
      writeFileSync(join(mine, 'SKILL.md'), 'MINE\n');
      const result = await provisionSkills(worktree, [team], [team]);
      expect(readFileSync(join(mine, 'SKILL.md'), 'utf8')).toBe('MINE\n');
      expect(existsSync(join(mine, 'references'))).toBe(false);
      expect(result.teamCopies['team-mine']).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  it('keeps a user-replaced team copy on the next pass', async () => {
    const { team, cleanup } = await seedTeam('team-replaced');
    try {
      await provisionSkills(worktree, [team], [team]);
      const dest = join(worktree, '.agents', 'skills', 'team-replaced');
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dest);
      writeFileSync(join(dest, 'SKILL.md'), 'MINE\n');
      await provisionSkills(worktree, [], [team]);
      expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toBe('MINE\n');
      expect(existsSync(join(dest, '.cezar-team-skill.json'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('deletes nothing outside the worktree after an agent dir is redirected out of it', async () => {
    await provisionSkills(worktree, [lead], [lead, helper]);
    const moved = join(main, 'moved-claude');
    renameSync(join(worktree, '.claude'), moved);
    symlinkSync(moved, join(worktree, '.claude'));
    await provisionSkills(worktree, [], [{ ...lead, body: 'no companions now' }, helper]);
    expect(existsSync(join(moved, 'skills', 'helper-skill', 'SKILL.md'))).toBe(true);
    await removeProvisionedSkills(worktree);
    expect(lstatSync(join(moved, 'skills', 'lead-skill')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(moved, 'skills', '.gitignore'))).toBe(true);
  });

  it('writes nothing once the run is cancelled', async () => {
    const result = await provisionSkills(worktree, [lead], [lead, helper], { cancelled: () => true });
    expect(result.installed).toEqual([]);
    for (const dir of AGENT_DIRS) expect(existsSync(join(worktree, dir))).toBe(false);
    expect(existsSync(await manifestPath())).toBe(false);
  });

  it('two overlapping passes keep both roots, entries and ignore lines', async () => {
    const other: Skill = { ...helper, name: 'other-skill' };
    await Promise.all([
      provisionSkills(worktree, [lead], [lead, other]),
      provisionSkills(worktree, [other], [lead, other]),
    ]);
    const manifest = JSON.parse(readFileSync(await manifestPath(), 'utf8')) as { roots: string[]; entries: Array<{ path: string }> };
    expect([...manifest.roots].sort()).toEqual(['lead-skill', 'other-skill']);
    expect(manifest.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      '.agents/skills/lead-skill', '.agents/skills/other-skill',
    ]));
    expect(readFileSync(join(worktree, '.agents', 'skills', '.gitignore'), 'utf8'))
      .toBe(`${PROVISION_IGNORE_MARK}\n/.gitignore\n/lead-skill\n/other-skill\n`);
    expect(await status(worktree)).toBe('');
  });

  it('an entry interrupted before its record stays out of git and is reinstalled', async () => {
    await provisionSkills(worktree, [helper], [lead, helper]);
    // The link lands, then the pass dies before it records it: the copy fallback cannot
    // copy a directory onto its own link, so the pass ends as a crash would.
    const interrupted = async (target: string, path: string, type?: 'dir' | 'file' | 'junction') => {
      symlinkSync(target, path, type);
      throw new Error('interrupted');
    };
    await provisionSkills(worktree, [lead], [lead, helper], { symlink: interrupted });
    expect(lstatSync(join(worktree, '.claude', 'skills', 'lead-skill')).isSymbolicLink()).toBe(true);
    expect(await status(worktree)).toBe('');
    await provisionSkills(worktree, [], [lead, helper]);
    expect(await status(worktree)).toBe('');
    for (const dir of AGENT_DIRS) {
      expect(readlinkSync(join(worktree, dir, 'skills', 'lead-skill'))).toBe(join(home, 'skills-src', 'lead-skill'));
    }
    await removeProvisionedSkills(worktree);
    for (const dir of AGENT_DIRS) expect(existsSync(join(worktree, dir, 'skills', 'lead-skill'))).toBe(false);
  });

  it('an interrupted entry the user then changed stays theirs, and out of git', async () => {
    const interrupted = async (target: string, path: string, type?: 'dir' | 'file' | 'junction') => {
      symlinkSync(target, path, type);
      throw new Error('interrupted');
    };
    await provisionSkills(worktree, [lead], [lead], { symlink: interrupted });
    const dest = join(worktree, '.claude', 'skills', 'lead-skill');
    rmSync(dest);
    mkdirSync(dest);
    writeFileSync(join(dest, 'SKILL.md'), 'MINE\n');
    await provisionSkills(worktree, [], [lead]);
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toBe('MINE\n');
    expect(await status(worktree)).toBe('');
    await provisionSkills(worktree, [], [{ ...lead, body: 'still lead' }]);
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toBe('MINE\n');
    await removeProvisionedSkills(worktree);
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toBe('MINE\n');
  });

  it('a copied skill follows its source when the source changes in place', async () => {
    const refuse = async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
    await provisionSkills(worktree, [lead], [lead, helper], { symlink: refuse });
    writeFileSync(join(home, 'skills-src', 'lead-skill', 'references', 'notes.txt'), 'new notes\n');
    writeFileSync(helper.path, 'NEW-HELPER\n');
    const result = await provisionSkills(worktree, [], [lead, helper], { symlink: refuse });
    expect(result.installed).toEqual(['lead-skill', 'helper-skill']);
    expect(readFileSync(join(worktree, '.agents', 'skills', 'lead-skill', 'references', 'notes.txt'), 'utf8')).toBe('new notes\n');
    expect(readFileSync(join(worktree, '.agents', 'skills', 'helper-skill', 'SKILL.md'), 'utf8')).toBe('NEW-HELPER\n');
  });

  it('writes nothing outside a git worktree', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cez-provision-plain-'));
    try {
      expect((await provisionSkills(plain, [lead], [lead])).installed).toEqual([]);
      expect(existsSync(join(plain, '.agents'))).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
