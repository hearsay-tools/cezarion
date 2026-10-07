import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { bareDirFor } from './skills-remote.ts';

const execFileAsync = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** A team-skills source already cloned into the global bare cache, as a restart finds it (#859). */
export interface SeededTeamSkillsClone {
  sourceDir: string;
  bareDir: string;
  /** Commit one more `commands/<name>.md` upstream and pull it into the bare clone. */
  addSkill(name: string, body: string): Promise<void>;
}

/**
 * Seed `bareDirFor(repo)` — which follows `$HOME`, so stub it first — with a real
 * bare clone of a local repo holding one `commands/<name>.md` per entry. No stamp
 * is written, so a passive load treats the clone as due for a fetch.
 */
export async function seedTeamSkillsClone(repo: string, skills: Record<string, string>): Promise<SeededTeamSkillsClone> {
  const sourceDir = mkdtempSync(join(tmpdir(), 'cez-team-skills-src-'));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: sourceDir });
  const commit = async (files: Record<string, string>, message: string) => {
    mkdirSync(join(sourceDir, 'commands'), { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(sourceDir, 'commands', `${name}.md`), body);
    await execFileAsync('git', ['add', '-A'], { cwd: sourceDir });
    await execFileAsync('git', [...GIT_ID, 'commit', '-q', '-m', message], { cwd: sourceDir });
  };
  await commit(skills, 'skills');
  const bareDir = bareDirFor(repo);
  mkdirSync(join(bareDir, '..'), { recursive: true });
  await execFileAsync('git', ['clone', '-q', '--bare', '--', sourceDir, bareDir]);
  return {
    sourceDir,
    bareDir,
    addSkill: async (name, body) => {
      await commit({ [name]: body }, name);
      await execFileAsync('git', ['fetch', '-q', 'origin', '+refs/heads/*:refs/heads/*'], { cwd: bareDir });
    },
  };
}

/** Point a fixture repo's `.ai/cezar/config.json` at exactly these team-skill sources. */
export function writeSkillsReposConfig(repoRoot: string, repos: string[]): void {
  mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
  writeFileSync(
    join(repoRoot, '.ai/cezar/config.json'),
    JSON.stringify({ skillsRepos: repos.map((repo) => ({ repo, ref: 'main' })) }),
  );
}
