import type { Skill } from './skills.ts';

/**
 * Install a task's selected skill — and every catalog skill it names, transitively — into the
 * run's OWN task worktree, where the agent's native skill lookup finds it (hearsay-tools/cezarion#1408,
 * port of upstream open-mercato/cezar#1429).
 *
 * A task worktree is a fresh checkout: `npx skills` install dirs are gitignored, global skills
 * live outside it, and team skills live only in cezar's bare-clone cache. So an agent answered
 * "Unknown skill" for the selected skill, and a companion it runs verbatim
 * (`om-auto-review-pr` → `om-code-review`) was found nowhere.
 *
 * The companion set is a heuristic: a skill whose body names another catalog skill pulls it in.
 * It does not promise that every enabled skill is present.
 */

/** Bound on one closure: a skill that names the whole catalog must not install all of it. */
export const MAX_SKILL_CLOSURE = 24;

/** A skill name that is safe as one directory name (no separators, never `.`/`..`). */
export const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when `body` names `name` as a skill: hyphenated names by word, plain names only as `/name` or `` `name` ``. */
export function mentionsSkill(body: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = name.includes('-')
    ? `(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_-])`
    : `(?:/${escaped}|\`${escaped}\`)(?![A-Za-z0-9_-])`;
  return new RegExp(pattern).test(body);
}

/**
 * The roots plus every catalog skill their bodies name, transitively: roots first, at most
 * `MAX_SKILL_CLOSURE`. The first catalog entry for a name wins, so a catalog in precedence order
 * (`discoverSkills`, local first) keeps that order. `truncated` names the first skill the cap left out.
 */
export function skillClosure(
  roots: readonly Skill[],
  catalog: readonly Skill[],
): { skills: Skill[]; truncated?: string } {
  const byName = new Map<string, Skill>();
  for (const skill of catalog) if (!byName.has(skill.name)) byName.set(skill.name, skill);
  const candidates = [...byName.values()];
  const skills: Skill[] = [];
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const skill = queue.shift()!;
    if (seen.has(skill.name)) continue;
    if (skills.length >= MAX_SKILL_CLOSURE) return { skills, truncated: skill.name };
    seen.add(skill.name);
    skills.push(skill);
    for (const candidate of candidates) {
      if (!seen.has(candidate.name) && mentionsSkill(skill.body, candidate.name)) queue.push(candidate);
    }
  }
  return { skills };
}
