import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Skill } from './skills.ts';
import { excludeFromGit, materializeSkillDir, TEAM_SKILL_AGENT_DIRS } from './skills-remote.ts';
import {
  fileIdentity,
  identityOf,
  LinkRefused,
  withWorktreeFiles,
  type EntryContent,
  type WorktreeFiles,
  type WorktreeFilesOptions,
} from './worktree-manifest.ts';

/**
 * Provision selected skills, the skills a step's prompt names as `/name`, and heuristically
 * discovered catalog companions in the run’s own worktree. This is not a promise that every
 * enabled skill is installed.
 */

/** Bound on one closure's companions: a skill that names the whole catalog must not install all
 *  of it. Roots are never capped: each one is a skill a human selected or named. */
export const MAX_SKILL_CLOSURE = 24;

/** A skill name that is safe as one directory name (no separators, never `.`/`..`). */
export const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * True when `body` names `name` as a skill: hyphenated names by word, plain names only as `/name`,
 * `` `name` `` or inside a matched pair of quotes (`"name"`, `'name'`, `“name”`, `‘name’`), which
 * is how `call the Skill tool with "grilling"` names one (hearsay-tools/cezarion#1480).
 */
export function mentionsSkill(body: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = name.includes('-')
    ? `(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_-])`
    : `(?:/${escaped}|\`${escaped}\`|"${escaped}"|'${escaped}'|\u201c${escaped}\u201d|\u2018${escaped}\u2019)(?![A-Za-z0-9_-])`;
  return new RegExp(pattern).test(body);
}

/**
 * True when a human's `text` names `name` as a typed `/name`, at the start of a word and never
 * as a path segment (`a/name`, `~/name`, `C:/name`, `/name/a`, `/name.ext`, a URL). Stricter than
 * `mentionsSkill`: a prompt is prose and paths, where a bare hyphenated word is not a request to
 * run a skill (hearsay-tools/cezarion#1672).
 */
export function namesSkillCommand(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_.~:/-])/${escaped}(?![A-Za-z0-9_/-]|\\.[A-Za-z0-9_])`).test(text);
}

/**
 * Every root, then the catalog skills their bodies name, transitively, while the closure holds
 * fewer than `MAX_SKILL_CLOSURE`. The first catalog entry for a name wins, so a catalog in
 * precedence order (`discoverSkills`, local first) keeps that order. `truncated` names the first
 * companion the cap left out; the cap never leaves out a root (hearsay-tools/cezarion#1672).
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
  const rootNames = new Set(roots.map((root) => root.name));
  while (queue.length) {
    const skill = queue.shift()!;
    if (seen.has(skill.name)) continue;
    // Roots lead the queue, so every root is in before the first companion meets the cap.
    if (skills.length >= MAX_SKILL_CLOSURE && !rootNames.has(skill.name)) return { skills, truncated: skill.name };
    seen.add(skill.name);
    skills.push(skill);
    for (const candidate of candidates) {
      if (!seen.has(candidate.name) && mentionsSkill(skill.body, candidate.name)) queue.push(candidate);
    }
  }
  return { skills };
}


// ---- installing, ignoring and recording ---------------------------------------------------

/** First line of the `.gitignore` cezar owns inside a worktree skills dir. */
export const PROVISION_IGNORE_MARK = '# cezar: skills installed for this task, not part of the repository';

/** Matches `TEAM_SKILL_MARKER` in skills-remote.ts: it names the team source of a copy. */
const TEAM_MARKER = '.cezar-team-skill.json';

export interface ProvisionResult {
  /** Skills with at least one entry created or rewritten by this pass, in closure order. */
  installed: string[];
  /** The first skill `MAX_SKILL_CLOSURE` left out, if any. */
  truncated?: string;
  /** Absolute directories that hold cezar's current copy of a team directory skill, by skill name. */
  teamCopies: Record<string, string[]>;
}

export interface ProvisionOptions extends WorktreeFilesOptions {
  /** True once the run stopped: the pass writes nothing more from its next step on. */
  cancelled?: () => boolean;
}

/** Thrown inside a pass when `cancelled()` turns true; the pass ends as a best-effort failure. */
class ProvisionCancelled extends Error {}

function skillMarkdown(skill: Skill): string {
  const front = [`name: ${JSON.stringify(skill.name)}`];
  if (skill.description) front.push(`description: ${JSON.stringify(skill.description)}`);
  return `---\n${front.join('\n')}\n---\n\n${skill.body.trim()}\n`;
}

type Plan =
  | { how: 'team' }
  | { how: 'link-dir'; target: string; source: string }
  | { how: 'link-file'; target: string; source: string }
  | { how: 'write'; text: string; source: string };

/** How one skill becomes a worktree entry. A local skill is linked, so its references/ come along. */
function planFor(skill: Skill): Plan {
  if (skill.source === 'team' && skill.team?.dir) return { how: 'team' };
  const onDisk = skill.source !== 'team' && skill.source !== 'builtin' && isAbsolute(skill.path);
  if (onDisk && basename(skill.path) === 'SKILL.md') {
    const target = dirname(skill.path);
    return { how: 'link-dir', target, source: `dir:${target}` };
  }
  if (onDisk) return { how: 'link-file', target: skill.path, source: `file:${skill.path}` };
  const text = skillMarkdown(skill);
  return { how: 'write', text, source: `body:${createHash('sha256').update(text).digest('hex')}` };
}

const entryPath = (agentDir: string, name: string) => `${agentDir}/skills/${name}`;

/** One pass's shared state: what it installed, and every path its closure still wants. */
interface Pass {
  files: WorktreeFiles;
  installed: Set<string>;
  wanted: Set<string>;
  checkpoint: () => void;
}

/**
 * Provision roots and companions only in an owned task worktree, through its manifest
 * (`worktree-manifest.ts`): replace or remove only cezar's unchanged entries, and reject escaping
 * destinations. Install ignore rules before entries. On failure retain the system-prompt
 * fallback; never throw.
 */
export function provisionSkills(
  worktree: string,
  roots: readonly Skill[],
  catalog: readonly Skill[],
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  return withWorktreeFiles(worktree, 'skills', options, { installed: [], teamCopies: {} },
    (files) => provisionPass(files, roots, catalog, options));
}

async function provisionPass(
  files: WorktreeFiles,
  roots: readonly Skill[],
  catalog: readonly Skill[],
  options: ProvisionOptions,
): Promise<ProvisionResult> {
  const result: ProvisionResult = { installed: [], teamCopies: {} };
  const checkpoint = () => { if (options.cancelled?.()) throw new ProvisionCancelled(); };
  try {
    checkpoint();
    const skills = passClosure(files, roots, catalog, result);
    const pass: Pass = { files, installed: new Set(), wanted: new Set(), checkpoint };
    for (const agentDir of TEAM_SKILL_AGENT_DIRS) {
      checkpoint();
      // Ignore first: an entry git could see must never exist, not even for a crash's length.
      // Only names cezar may write: a recorded entry or a free path, never the user's own skill.
      const planned: string[] = [];
      for (const skill of skills) {
        const rel = entryPath(agentDir, skill.name);
        if (files.entry(rel) || !(await files.present(rel))) planned.push(skill.name);
      }
      await syncIgnore(files, agentDir, [...ownedNames(files, agentDir), ...planned]);
    }
    for (const skill of skills) {
      checkpoint();
      const plan = planFor(skill);
      if (plan.how === 'team') result.teamCopies[skill.name] = await placeTeamCopies(pass, skill);
      else await placeLinkedSkill(pass, skill, plan);
    }
    checkpoint();
    await removeUnwanted(pass);
    for (const agentDir of TEAM_SKILL_AGENT_DIRS) await syncIgnore(files, agentDir, ownedNames(files, agentDir));
    result.installed = skills.map((skill) => skill.name).filter((name) => pass.installed.has(name));
  } catch {
    // Best effort: the skill body still rides the system prompt.
  }
  return result;
}

/** Every root this worktree asked for, earlier passes included, and the companions they name. */
function passClosure(files: WorktreeFiles, roots: readonly Skill[], catalog: readonly Skill[], result: ProvisionResult): Skill[] {
  const safeRoots = roots.filter((skill) => SAFE_SKILL_NAME.test(skill.name));
  const rootNames = [...new Set([...files.roots, ...safeRoots.map((skill) => skill.name)])];
  const allRoots = rootNames.flatMap((name) => {
    const found = safeRoots.find((skill) => skill.name === name) ?? catalog.find((skill) => skill.name === name);
    return found ? [found] : [];
  });
  files.roots = allRoots.map((skill) => skill.name);
  const closure = skillClosure(allRoots, catalog);
  if (closure.truncated) result.truncated = closure.truncated;
  return closure.skills.filter((skill) => SAFE_SKILL_NAME.test(skill.name));
}

function ownedNames(files: WorktreeFiles, agentDir: string): string[] {
  return files.entries()
    .filter((entry) => entry.kind !== 'ignore-file' && entry.path.startsWith(`${agentDir}/skills/`))
    .map((entry) => entry.skill ?? '').filter(Boolean);
}

/** Keep `names` out of git in `<agentDir>/skills`, through cezar's own `.gitignore` when it may. */
async function syncIgnore(files: WorktreeFiles, agentDir: string, names: readonly string[]): Promise<void> {
  const rel = `${agentDir}/skills/.gitignore`;
  const state = await files.inspect(rel);
  if (state.owner === 'outside') return;
  if (state.owner === 'theirs' || state.owner === 'kept') {
    files.forget(rel);
    return excludeEach(files, agentDir, names);
  }
  const sorted = [...new Set(names)].sort();
  if (sorted.length === 0) {
    if (!(await files.remove(rel))) files.forget(rel);
    return files.save();
  }
  const text = [PROVISION_IGNORE_MARK, '/.gitignore', ...sorted.map((name) => `/${name}`)].join('\n') + '\n';
  if (state.owner === 'ours' && state.entry?.kind === 'ignore-file' && state.current === fileIdentity(text)) return;
  // The agent wrote the ignore file while cezar staged it: it stays theirs, as above.
  if ((await files.put(rel, { type: 'file', text }, { kind: 'ignore-file' })) === null) await excludeEach(files, agentDir, names);
}

async function excludeEach(files: WorktreeFiles, agentDir: string, names: readonly string[]): Promise<void> {
  for (const name of names) await excludeFromGit(files.worktree, `${agentDir}/skills/${name}`);
}

/** A local, global or built-in skill: a link, a generated `SKILL.md`, or a copy where links fail. */
async function placeLinkedSkill(pass: Pass, skill: Skill, plan: Exclude<Plan, { how: 'team' }>): Promise<void> {
  const { files } = pass;
  // A copy follows its source's content too, not only its path; digested only for a copy.
  let copyKey: Promise<string> | undefined;
  const copySource = () => (copyKey ??= plan.how === 'write'
    ? Promise.resolve(plan.source)
    : identityOf(plan.target).then((digest) => `${plan.source}#${digest}`));
  for (const agentDir of TEAM_SKILL_AGENT_DIRS) {
    pass.checkpoint();
    const rel = entryPath(agentDir, skill.name);
    const state = await files.inspect(rel);
    // Not cezar's (tracked, or the user's own), changed since, or out of the worktree: leave it.
    if (state.owner === 'outside' || state.owner === 'theirs') {
      files.forget(rel);
      continue;
    }
    pass.wanted.add(rel);
    // An interrupted entry that no longer matches may be the user's now: left alone, kept out of git.
    if (state.owner === 'kept') continue;
    const { entry } = state;
    if (state.owner === 'ours' && entry && entry.kind !== 'pending' && state.current === entry.identity
      && entry.source === (entry.kind === 'copy' ? await copySource() : plan.source)) continue;
    if (await placeEntry(files, rel, skill.name, plan, copySource)) pass.installed.add(skill.name);
  }
}

/**
 * Write one entry as `plan` says; a link the platform refuses falls back to a copy. False when the
 * agent wrote at `rel` meanwhile, so nothing was placed.
 */
async function placeEntry(
  files: WorktreeFiles,
  rel: string,
  skill: string,
  plan: Exclude<Plan, { how: 'team' }>,
  copySource: () => Promise<string>,
): Promise<boolean> {
  if (plan.how === 'write') {
    const generated: EntryContent = { type: 'dir', files: [{ name: 'SKILL.md', text: plan.text }] };
    return (await files.put(rel, generated, { kind: 'generated', skill, source: plan.source })) !== null;
  }
  const linked: EntryContent = plan.how === 'link-dir'
    ? { type: 'link', target: plan.target, linkType: process.platform === 'win32' ? 'junction' : 'dir' }
    : { type: 'dir', files: [{ name: 'SKILL.md', linkTo: plan.target }] };
  try {
    return (await files.put(rel, linked, { kind: plan.how === 'link-dir' ? 'link' : 'generated', skill, source: plan.source })) !== null;
  } catch (error) {
    if (!(error instanceof LinkRefused)) throw error;
    const copied: EntryContent = plan.how === 'link-dir'
      ? { type: 'copy', from: plan.target }
      : { type: 'dir', files: [{ name: 'SKILL.md', copyOf: plan.target }] };
    return (await files.put(rel, copied, { kind: 'copy', skill, source: await copySource() })) !== null;
  }
}

/**
 * A team directory skill: materialized in a staging dir, then placed in each agent dir whose
 * path is free or still holds cezar's unchanged copy. A copy the agent changed, or added files
 * to, stays as it is. Returns the worktree dirs that hold cezar's current copy.
 */
async function placeTeamCopies(pass: Pass, skill: Skill): Promise<string[]> {
  const { files } = pass;
  const staging = await files.stagingDir();
  const written = new Set(await materializeSkillDir(staging, skill, async () => undefined).catch(() => [] as string[]));
  const copies: string[] = [];
  for (const agentDir of TEAM_SKILL_AGENT_DIRS) {
    pass.checkpoint();
    const rel = entryPath(agentDir, skill.name);
    const staged = resolve(staging, agentDir, 'skills', skill.name);
    if (!written.has(staged)) continue;
    const state = await files.inspect(rel);
    if (state.owner === 'outside' || state.owner === 'theirs') {
      files.forget(rel);
      continue;
    }
    pass.wanted.add(rel);
    if (state.owner === 'kept') continue;
    const identity = await identityOf(staged);
    const marker = await readFile(join(staged, TEAM_MARKER), 'utf8').catch(() => null);
    if (identity === null || marker === null) continue;
    const meta = { kind: 'team-copy' as const, skill: skill.name, source: `team:${JSON.stringify(JSON.parse(marker))}` };
    if (state.owner === 'ours' && state.current === identity) {
      if (state.entry?.kind !== 'team-copy') files.record(rel, meta, identity);
    } else {
      if ((await files.put(rel, { type: 'staged', path: staged }, meta)) === null) continue;
      pass.installed.add(skill.name);
    }
    copies.push(resolve(files.worktree, rel));
  }
  return copies;
}

/** Owned entries the closure no longer wants go, while they are still what cezar left. */
async function removeUnwanted({ files, wanted }: Pass): Promise<void> {
  for (const entry of files.entries()) {
    if (entry.kind === 'ignore-file' || wanted.has(entry.path)) continue;
    // Changed since an interrupted pass, or not this cezar's to judge: never deleted, still out of git.
    if ((await files.inspect(entry.path)).owner === 'kept') continue;
    if (!(await files.remove(entry.path))) files.forget(entry.path);
  }
  await files.save();
}

/**
 * Remove every entry `provisionSkills` recorded in `worktree` that still is what cezar left, and
 * its owned ignore files, then drop its entries and roots from the manifest. A path the user
 * replaced stays. Never throws. A later skills design calls this before it installs its own view.
 */
export function removeProvisionedSkills(worktree: string): Promise<void> {
  return withWorktreeFiles(worktree, 'skills', {}, undefined, async (files) => {
    try {
      for (const entry of files.entries()) {
        // Never deleted, and still kept out of git once cezar's ignore file is gone.
        if ((await files.inspect(entry.path)).owner === 'kept') await excludeFromGit(files.worktree, `${entry.path}/`);
        else if (await files.remove(entry.path)) continue;
        files.forget(entry.path);
      }
      files.roots = [];
      await files.save();
    } catch {
      // Best effort.
    }
  });
}
