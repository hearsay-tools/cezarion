import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type Trust = boolean | 'no-api';

/** Runs the extension's handler in a child node, the way pi loads it, with HOME pinned to `home`. */
function discover(cwd: string, trust: Trust, home: string): { events: string[]; result: unknown } {
  const extensionUrl = new URL('../../scripts/pi-project-skills.mjs', import.meta.url);
  const ctx = trust === 'no-api' ? '{}' : `{ isProjectTrusted: () => ${trust} }`;
  const source = `
    import register from ${JSON.stringify(extensionUrl.href)};
    const handlers = new Map();
    register({ on(type, callback) { handlers.set(type, callback); } });
    const handler = handlers.get('resources_discover');
    const result = handler ? await handler({ type: 'resources_discover', cwd: ${JSON.stringify(cwd)}, reason: 'startup' }, ${ctx}) : 'no handler';
    process.stdout.write(JSON.stringify({ events: [...handlers.keys()], result: result ?? null }));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  return JSON.parse(output);
}

function skillsDir(...parts: string[]): string {
  const dir = join(...parts);
  mkdirSync(join(dir, 'example'), { recursive: true });
  writeFileSync(join(dir, 'example', 'SKILL.md'), '---\nname: example\ndescription: fixture\n---\n');
  return dir;
}

describe('pi project-skills extension (hearsay-tools/cezarion#1295)', () => {
  let root: string;
  let home: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-pi-project-skills-'));
    home = join(root, 'home');
    mkdirSync(home);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function repo(name: string, git: 'dir' | 'file' = 'dir'): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    if (git === 'dir') mkdirSync(join(dir, '.git'));
    else writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/w\n');
    return dir;
  }

  it('registers only resources_discover: no project_trust handler, so the trust decision stays the user\'s', () => {
    const cwd = repo('repo');
    expect(discover(cwd, true, home).events).toEqual(['resources_discover']);
  });

  it('offers .pi/skills, then .agents/skills, when the folder is untrusted', () => {
    const cwd = repo('repo');
    const agents = skillsDir(cwd, '.agents', 'skills');
    const pi = skillsDir(cwd, '.pi', 'skills');
    expect(discover(cwd, false, home).result).toEqual({ skillPaths: [pi, agents] });
  });

  it('returns nothing when pi already trusts the folder, so its own settings filters apply', () => {
    const cwd = repo('repo');
    skillsDir(cwd, '.agents', 'skills');
    skillsDir(cwd, '.pi', 'skills');
    expect(discover(cwd, true, home).result).toBeNull();
  });

  it('returns nothing when the pi build has no isProjectTrusted (no trust gate to work around)', () => {
    const cwd = repo('repo');
    skillsDir(cwd, '.agents', 'skills');
    skillsDir(cwd, '.pi', 'skills');
    expect(discover(cwd, 'no-api', home).result).toBeNull();
  });

  it('omits folders that do not exist or are not directories', () => {
    const cwd = repo('repo');
    expect(discover(cwd, false, home).result).toEqual({ skillPaths: [] });
    mkdirSync(join(cwd, '.pi'));
    writeFileSync(join(cwd, '.pi', 'skills'), 'not a directory');
    const agents = skillsDir(cwd, '.agents', 'skills');
    expect(discover(cwd, false, home).result).toEqual({ skillPaths: [agents] });
  });

  it.each(['dir', 'file'] as const)(
    'walks .agents/skills from cwd up to the git root (.git %s) and no further; .pi/skills only at cwd',
    (git) => {
      const top = repo('outer/repo', git);
      const outside = skillsDir(root, 'outer', '.agents', 'skills');
      const cwd = join(top, 'packages', 'app');
      const atCwd = skillsDir(cwd, '.agents', 'skills');
      const between = skillsDir(top, 'packages', '.agents', 'skills');
      const atRoot = skillsDir(top, '.agents', 'skills');
      skillsDir(top, '.pi', 'skills');
      const result = discover(cwd, false, home).result as { skillPaths: string[] };
      expect(result).toEqual({ skillPaths: [atCwd, between, atRoot] });
      expect(result.skillPaths).not.toContain(outside);
    },
  );

  it('stops a linked worktree nested in the main checkout at the worktree', () => {
    const main = repo('main');
    const mainSkills = skillsDir(main, '.agents', 'skills');
    const worktree = join(main, '.ai', 'cezar', 'worktrees', 'run-1');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'run-1')}\n`);
    const worktreeSkills = skillsDir(worktree, '.agents', 'skills');
    const result = discover(worktree, false, home).result as { skillPaths: string[] };
    expect(result).toEqual({ skillPaths: [worktreeSkills] });
    expect(result.skillPaths).not.toContain(mainSkills);
  });

  it('leaves the user\'s ~/.agents/skills to pi, which loads it with or without trust', () => {
    mkdirSync(join(home, '.git'));
    const userSkills = skillsDir(home, '.agents', 'skills');
    const cwd = join(home, 'project');
    const projectSkills = skillsDir(cwd, '.agents', 'skills');
    const result = discover(cwd, false, home).result as { skillPaths: string[] };
    expect(result).toEqual({ skillPaths: [projectSkills] });
    expect(result.skillPaths).not.toContain(userSkills);
  });
});
