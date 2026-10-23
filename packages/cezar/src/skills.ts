import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, basename, dirname, extname } from 'node:path';
import { teamSkillRefSchema, type TeamSkillRef } from '@open-mercato/cezar-contract/skills';
import { getTeamSkillsCached } from './skills-remote.ts';
import { readProjectUiState } from './ui-state.ts';

/**
 * A skill is a Markdown file with optional YAML-ish frontmatter (`name`,
 * `description`). Discovered from the repo's `.ai/skills/` (shared with other
 * agent tooling), `.ai/cezar/skills/` (cez-local), the `npx skills` install
 * dirs (`.agents/skills` + the per-agent mirrors, project and global), and
 * the configured team skills repos (spec 005 — bare clones, no checkout).
 * Adapted from @cezar/core's skill-catalog.
 */
export interface Skill {
  name: string;
  description?: string;
  /** Advisory composer hint: untouched run-mode choices default to interactive, in-place execution. */
  interactive?: true;
  body: string;
  path: string;
  source: 'ai' | 'cezar' | 'agents' | 'global' | 'team' | 'builtin';
  /** Team skills only: where the definition lives in its skills repo. */
  team?: {
    repo: string;
    ref: string;
    path: string;
    /** True for the `SKILL.md` convention — a whole directory (references/…). */
    dir: boolean;
    /** The exact commit `ref` resolved to when the skill was read (#428). */
    commit?: string;
  };
}

/* Precedence order — earlier dirs win name collisions. `npx skills` writes
   the canonical copy to `.agents/skills/<name>/SKILL.md` and mirrors it into
   each agent's dir (often as symlinks) — scanning them all and deduping by
   name yields exactly the union of unique skills.

   Exported for the drift guard in `test/unit/skill-dirs.test.ts` (#374): the
   cockpit's empty-state hint hand-copies this list into the bundle
   (`packages/web/src/components/skill-empty-hint.tsx`) because it runs in another
   process, so adding a dir here without updating the hint makes the hint lie.
   That test pins this list and says where to go. */
export const SKILL_DIRS: Array<{ dir: string; source: Skill['source'] }> = [
  { dir: '.ai/cezar/skills', source: 'cezar' },
  { dir: '.ai/skills', source: 'ai' },
  { dir: '.agents/skills', source: 'agents' },
  { dir: '.claude/skills', source: 'agents' },
  { dir: '.codex/skills', source: 'agents' },
  { dir: '.cursor/skills', source: 'agents' },
  { dir: '.opencode/skills', source: 'agents' },
];

/* Deliberately `homedir()` and not `agentHomePaths().claude`: these do NOT follow an
   agent profile (`src/core/agent-profiles.ts`). A skill is CONTENT — a playbook — not
   identity, and a second Claude login is not a second skill library. `npx skills`, which
   writes the `~/.claude/skills` mirror, is profile-unaware for the same reason.

   Resolved at catalog-read time (not module load) so a test can plant fixtures under a
   temp `$HOME`. #366: empty under vitest — the same `process.env.VITEST` seam #365 uses
   for the vendor team source — so the unit suite does not merge the developer's real
   `~/.agents/skills` / `~/.claude/skills`. Production is unchanged. */
function globalSkillDirs(): Array<{ dir: string; source: Skill['source'] }> {
  if (process.env.VITEST) return [];
  return [
    { dir: join(homedir(), '.agents/skills'), source: 'global' },
    { dir: join(homedir(), '.claude/skills'), source: 'global' },
  ];
}

/**
 * Discover the merged skill catalog for a repo. Name collisions resolve
 * local-first: `.ai/cezar/skills` → `.ai/skills` → `.agents/skills` + agent
 * mirrors → global (`~/.agents/skills`, `~/.claude/skills`) → team repo
 * ("the user's repo is the source of truth"). Missing directories are fine —
 * an empty catalog is fully supported (steps fall back to their plain
 * prompt). Team skills come from the in-process cache; the first call starts
 * a background load so nothing here ever waits on the network.
 *
 * Off-list: `disabledTeamSkills` in this project's `.ai/cezar/ui-state.json` names team skills
 * by source repo and name. They are dropped from the team list before de-duplication, so the
 * same name from another source still shows. Only the project's own file is read, and an absent
 * or malformed list switches nothing off. This is the single chokepoint, so the decision is
 * identical for every consumer — catalog, composer picker, planner, runner — and companion
 * provisioning applies it too.
 *
 * `builtin` skills (#774) come from the caller, which alone knows whether they may be offered
 * (`RunManager.builtinSkills`). They are appended AFTER the sort, lowest precedence: any
 * discovered skill of the same name hides them.
 */
export async function discoverSkills(repoRoot: string, options: { builtin?: readonly Skill[] } = {}): Promise<Skill[]> {
  const [lists, uiState] = await Promise.all([
    Promise.all([
      ...SKILL_DIRS.map(({ dir, source }) => readMarkdownSkills(resolve(repoRoot, dir), source)),
      ...globalSkillDirs().map(({ dir, source }) => readMarkdownSkills(dir, source)),
    ]),
    readProjectUiState(repoRoot),
  ]);
  const teamSkills = filterDisabledTeamSkills(getTeamSkillsCached(repoRoot), readDisabledTeamSkills(uiState));
  const merged: Skill[] = [];
  const seen = new Set<string>();
  for (const skills of [...lists, teamSkills]) {
    for (const skill of skills) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      merged.push(skill);
    }
  }
  merged.sort((a, b) => a.name.localeCompare(b.name));
  for (const skill of options.builtin ?? []) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    merged.push({ ...skill });
  }
  return merged;
}

/**
 * The switched-off team skills from a raw `ui-state.json` object. Defensive because the file is
 * user-editable: a value that is not an array reads as `[]`, and entries that do not parse as a
 * `{ repo, name }` ref are dropped rather than thrown on.
 */
export function readDisabledTeamSkills(uiState: Record<string, unknown>): TeamSkillRef[] {
  const value = uiState.disabledTeamSkills;
  if (!Array.isArray(value)) return [];
  const refs: TeamSkillRef[] = [];
  for (const entry of value) {
    const parsed = teamSkillRefSchema.safeParse(entry);
    if (parsed.success) refs.push(parsed.data);
  }
  return refs;
}

/**
 * Drop every team skill the project switched off, matched on source repo AND name. Local skills
 * carry no `team` and are always kept. Pure, so it is testable without a network clone.
 */
export function filterDisabledTeamSkills(teamSkills: readonly Skill[], disabled: readonly TeamSkillRef[]): Skill[] {
  if (disabled.length === 0) return [...teamSkills];
  const off = new Set(disabled.map((ref) => JSON.stringify([ref.repo, ref.name])));
  return teamSkills.filter((skill) => !skill.team || !off.has(JSON.stringify([skill.team.repo, skill.name])));
}

/**
 * Walk a skills dir for entrypoints, following directory symlinks. Once a
 * directory contains `SKILL.md`, it is one directory-based skill and its
 * supporting Markdown (for example `references/*.md`) is not scanned. Other
 * directories retain the legacy recursive `*.md` discovery behavior.
 */
async function skillEntryPaths(
  dir: string,
  depth: number,
  visited: Set<string>,
): Promise<string[]> {
  if (depth < 0) return [];
  let real: string;
  try {
    real = await realpath(dir);
  } catch {
    return []; // missing dir or dangling symlink
  }
  if (visited.has(real)) return [];
  visited.add(real);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skillEntry = entries.find((entry) => entry.name === 'SKILL.md');
  if (skillEntry) {
    const skillPath = join(dir, skillEntry.name);
    try {
      if ((await stat(skillPath)).isFile()) return [skillPath];
    } catch {
      // A dangling or unreadable SKILL.md does not hide other valid entries.
    }
  }

  const paths: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        isDir = (await stat(path)).isDirectory(); // stat follows the link
      } catch {
        continue; // dangling symlink
      }
    }
    if (isDir) {
      paths.push(...(await skillEntryPaths(path, depth - 1, visited)));
    } else if (extname(entry.name).toLowerCase() === '.md') {
      paths.push(path);
    }
  }
  return paths;
}

async function readMarkdownSkills(dir: string, source: Skill['source']): Promise<Skill[]> {
  const paths = await skillEntryPaths(dir, 4, new Set());
  const skills: Skill[] = [];
  for (const absPath of paths) {
    let raw: string;
    try {
      raw = await readFile(absPath, 'utf8');
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(raw);
    const base = basename(absPath, extname(absPath));
    // The `SKILL.md` convention names the skill after its directory.
    const fallback = base.toLowerCase() === 'skill' ? basename(dirname(absPath)) : base;
    const name =
      typeof frontmatter.name === 'string' && frontmatter.name.trim()
        ? frontmatter.name.trim()
        : fallback;
    const description =
      typeof frontmatter.description === 'string' && frontmatter.description.trim()
        ? frontmatter.description.trim()
        : undefined;
    const interactive = frontmatter.interactive === 'true' ? true : undefined;
    skills.push({ name, description, interactive, body, path: absPath, source });
  }
  return skills;
}

type FrontmatterValue = string | string[];

/**
 * Tiny purpose-built frontmatter parser — a leading `---\n … \n---\n` block
 * with `key: value` lines, `key: [a, b]` inline arrays and `key:` + `  - a`
 * block arrays. Deliberately not full YAML so we avoid a parser dependency
 * for skill files.
 */
export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, FrontmatterValue>;
  body: string;
} {
  // Normalize CRLF and lone CR — otherwise frontmatter is silently dropped.
  const text = raw.replace(/\r\n?/g, '\n');
  if (!text.startsWith('---\n')) return { frontmatter: {}, body: raw };

  // Match the closing delimiter only on its own line so a `---` thematic
  // break inside the body doesn't terminate the block early.
  const end = text.indexOf('\n---\n', 4);
  const endAtEof = text.endsWith('\n---') ? text.length - 4 : -1;
  const closeAt = end === -1 ? endAtEof : end;
  if (closeAt === -1) return { frontmatter: {}, body: raw };

  const block = text.slice(4, closeAt);
  const afterDelimiter = end === -1 ? -1 : text.indexOf('\n', closeAt + 1);
  const body = afterDelimiter === -1 ? '' : text.slice(afterDelimiter + 1);

  const frontmatter: Record<string, FrontmatterValue> = {};
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    const rest = (m[2] ?? '').trim();

    if (rest === '') {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1] ?? '')) {
        items.push(stripQuotes((lines[i + 1] ?? '').replace(/^\s*-\s+/, '').trim()));
        i++;
      }
      frontmatter[key] = items;
      continue;
    }

    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      frontmatter[key] = inner
        ? inner
            .split(',')
            .map((s) => stripQuotes(s.trim()))
            .filter((s) => s.length > 0)
        : [];
      continue;
    }

    frontmatter[key] = stripQuotes(rest);
  }

  return { frontmatter, body };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
