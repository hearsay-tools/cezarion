import { execFile } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Skill } from './skills.ts';
import { excludeFromGit, landsInside, materializeSkillDir, TEAM_SKILL_AGENT_DIRS } from './skills-remote.ts';

const execFileAsync = promisify(execFile);

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

// ---- installing, ignoring and recording ---------------------------------------------------

/** First line of the `.gitignore` cezar owns inside a worktree skills dir. */
export const PROVISION_IGNORE_MARK = '# cezar: skills installed for this task, not part of the repository';

/** The ownership record, in the worktree's private git dir: outside the tree and every link target. */
const MANIFEST_FILE = 'cezar-skills.json';

/** Matches `TEAM_SKILL_MARKER` in skills-remote.ts: a team copy is cezar's while it carries it. */
const TEAM_MARKER = '.cezar-team-skill.json';

/**
 * One path cezar created in a worktree. `identity` is what cezar left there (a link's target, a
 * digest of a tree, a team copy's marker); an entry is removed or rewritten only while the path
 * still has it, so a path the user replaced stays theirs. `source` says what the entry was made
 * from, so a moved or changed skill is rewritten.
 */
export interface ProvisionedEntry {
  /** `/`-joined, relative to the worktree. */
  path: string;
  /** `pending` is saved before an entry is created, with the identity the finished entry will
   *  have, and replaced once it exists. A pass that died between the two leaves a path that stays
   *  out of git; it is rewritten only while it still matches, so one the user changed stays theirs. */
  kind: 'link' | 'copy' | 'generated' | 'team-copy' | 'ignore-file' | 'pending';
  skill?: string;
  source?: string;
  identity: string;
  /** A pending entry's other finished form: the copy a failed link falls back to. */
  alternate?: string;
}

/** `current` is what cezar left at the entry's path (either finished form of a pending one). */
function matches(record: ProvisionedEntry, current: string | null): boolean {
  return current !== null && (current === record.identity || current === record.alternate);
}

export interface SkillManifest {
  version: 1;
  /** Every skill a pass asked for in this worktree; later passes keep their closures. */
  roots: string[];
  entries: ProvisionedEntry[];
}

export interface ProvisionResult {
  /** Skills with at least one entry created or rewritten by this pass, in closure order. */
  installed: string[];
  /** The first skill `MAX_SKILL_CLOSURE` left out, if any. */
  truncated?: string;
  /** Absolute directories a team directory skill was copied to, by skill name. */
  teamCopies: Record<string, string[]>;
}

export interface ProvisionOptions {
  /** Injected in tests to exercise the copy fallback. */
  symlink?: (target: string, path: string, type?: 'dir' | 'file' | 'junction') => Promise<void>;
  /** True once the run stopped: the pass writes nothing more from its next step on. */
  cancelled?: () => boolean;
}

/** Thrown inside a pass when `cancelled()` turns true; the pass ends as a best-effort failure. */
class ProvisionCancelled extends Error {}

/**
 * One pass at a time per worktree: every pass reads the record, changes entries and rewrites the
 * record and the ignore files, so two overlapping passes (two live `/name` messages) would each
 * save over the other's roots and entries.
 */
const passes = new Map<string, Promise<unknown>>();

function serialized<T>(worktree: string, pass: () => Promise<T>): Promise<T> {
  const key = resolve(worktree);
  const previous = passes.get(key) ?? Promise.resolve();
  const next = previous.then(pass, pass);
  const settled = next.then(() => undefined, () => undefined);
  passes.set(key, settled);
  void settled.then(() => { if (passes.get(key) === settled) passes.delete(key); });
  return next;
}

/** Replace the record in one step: a crash leaves the old record or the new one, never half. */
async function writeManifest(file: string, manifest: SkillManifest): Promise<void> {
  const staging = `${file}.${process.pid}.tmp`;
  await writeFile(staging, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rename(staging, file);
}

async function gitDirOf(worktree: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--absolute-git-dir'], { cwd: worktree, timeout: 10_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function readManifest(file: string): Promise<SkillManifest> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<SkillManifest>;
    if (parsed.version === 1 && Array.isArray(parsed.entries) && Array.isArray(parsed.roots)) {
      return { version: 1, roots: parsed.roots.filter((r) => typeof r === 'string'), entries: parsed.entries };
    }
  } catch {
    // absent or unreadable: nothing is recorded as ours
  }
  return { version: 1, roots: [], entries: [] };
}

async function digestInto(hash: Hash, path: string, rel: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) hash.update(`L ${rel} ${await readlink(path)}\n`);
  else if (stat.isDirectory()) {
    hash.update(`D ${rel}\n`);
    for (const name of (await readdir(path)).sort()) await digestInto(hash, join(path, name), rel ? `${rel}/${name}` : name);
  } else {
    hash.update(`F ${rel} `);
    hash.update(await readFile(path));
    hash.update('\n');
  }
}

/** What is at `path` now, comparable with a recorded identity; null when nothing is there. */
async function identityOf(path: string, kind: ProvisionedEntry['kind']): Promise<string | null> {
  const stat = await lstat(path).catch(() => null);
  if (!stat) return null;
  if (stat.isSymbolicLink()) return `link:${await readlink(path)}`;
  if (kind === 'team-copy') {
    const marker = await readFile(join(path, TEAM_MARKER), 'utf8').catch(() => null);
    return marker === null ? `untracked-team:${path}` : `marker:${marker}`;
  }
  const hash = createHash('sha256');
  await digestInto(hash, path, '');
  return `tree:${hash.digest('hex')}`;
}

/** The identity `identityOf` reads from a directory holding exactly `files` (no subdirectories). */
function treeIdentity(files: ReadonlyArray<{ name: string; link?: string; content?: string | Buffer }>): string {
  const hash = createHash('sha256');
  hash.update('D \n');
  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (file.link !== undefined) hash.update(`L ${file.name} ${file.link}\n`);
    else {
      hash.update(`F ${file.name} `);
      hash.update(file.content ?? '');
      hash.update('\n');
    }
  }
  return `tree:${hash.digest('hex')}`;
}

async function removePath(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => null);
  if (!stat) return;
  if (stat.isDirectory()) await rm(path, { recursive: true, force: true });
  else await unlink(path);
}

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

/**
 * Provision `roots` and their companions into the run's OWN task worktree `worktree` (the caller
 * checks that; a run without one keeps the per-commit cache fallback). Never throws: a skill that
 * cannot be installed still reaches the agent as its system prompt.
 *
 * Every destination is `<agent dir>/skills/<name>` for each of `TEAM_SKILL_AGENT_DIRS`, resolved
 * through every link first; one that lands outside the worktree is skipped. A path cezar has no
 * record of (tracked in the repo, or the user's own) is never touched. Each entry is kept out of
 * git by a cezar-owned `.gitignore` in that skills dir, which affects this worktree only; when the
 * repo has its own `.gitignore` there, it is left alone and the shared `info/exclude` is used.
 *
 * The record lives in `<worktree git dir>/cezar-skills.json`, and is saved after every change:
 * the ignore line goes first, so a crash can leave an unrecorded entry (left alone, as anyone's)
 * but never one git would commit. Each pass also provisions the closures of the roots earlier
 * passes recorded, and removes owned entries that left them or whose source changed.
 */
export function provisionSkills(
  worktree: string,
  roots: readonly Skill[],
  catalog: readonly Skill[],
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  return serialized(worktree, () => provisionPass(worktree, roots, catalog, options));
}

async function provisionPass(
  worktree: string,
  roots: readonly Skill[],
  catalog: readonly Skill[],
  options: ProvisionOptions,
): Promise<ProvisionResult> {
  const result: ProvisionResult = { installed: [], teamCopies: {} };
  const checkpoint = () => { if (options.cancelled?.()) throw new ProvisionCancelled(); };
  try {
    checkpoint();
    const gitDir = await gitDirOf(worktree);
    const root = await realpath(worktree).catch(() => null);
    if (!gitDir || root === null) return result;
    const manifestFile = join(gitDir, MANIFEST_FILE);
    const manifest = await readManifest(manifestFile);
    const records = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    const save = () => writeManifest(manifestFile, { ...manifest, entries: [...records.values()] });
    // A recorded path is touched only while its skills dir still lands in this worktree: a
    // redirected agent dir must not turn a cleanup into a delete in another checkout.
    const contained = (rel: string) => landsInside(root, dirname(join(worktree, rel)));
    const makeLink = options.symlink ?? ((target, path, type) => symlink(target, path, type));
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';

    const safeRoots = roots.filter((skill) => SAFE_SKILL_NAME.test(skill.name));
    const rootNames = [...new Set([...manifest.roots, ...safeRoots.map((skill) => skill.name)])];
    const allRoots = rootNames.flatMap((name) => {
      const found = safeRoots.find((skill) => skill.name === name) ?? catalog.find((skill) => skill.name === name);
      return found ? [found] : [];
    });
    manifest.roots = allRoots.map((skill) => skill.name);
    const closure = skillClosure(allRoots, catalog);
    if (closure.truncated) result.truncated = closure.truncated;
    const skills = closure.skills.filter((skill) => SAFE_SKILL_NAME.test(skill.name));

    const installed = new Set<string>();
    const wanted = new Set<string>();
    const ownedNames = (agentDir: string): string[] => [...records.values()]
      .filter((entry) => entry.kind !== 'ignore-file' && entry.path.startsWith(`${agentDir}/skills/`))
      .map((entry) => entry.skill ?? '').filter(Boolean);

    /** Keep `names` out of git in `<agentDir>/skills`, through cezar's own `.gitignore` when it may. */
    const syncIgnore = async (agentDir: string, names: readonly string[]): Promise<void> => {
      const rel = `${agentDir}/skills/.gitignore`;
      const file = join(worktree, rel);
      if (!(await landsInside(root, file))) return;
      const record = records.get(rel);
      const current = await identityOf(file, 'ignore-file');
      if (current !== null && current !== record?.identity) {
        if (record) records.delete(rel);
        for (const name of names) await excludeFromGit(worktree, `${agentDir}/skills/${name}`);
        return;
      }
      const sorted = [...new Set(names)].sort();
      if (sorted.length === 0) {
        if (current !== null) await unlink(file);
        records.delete(rel);
        return save();
      }
      const text = [PROVISION_IGNORE_MARK, '/.gitignore', ...sorted.map((name) => `/${name}`)].join('\n') + '\n';
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text, 'utf8');
      records.set(rel, { path: rel, kind: 'ignore-file', identity: (await identityOf(file, 'ignore-file'))! });
      await save();
    };

    for (const agentDir of TEAM_SKILL_AGENT_DIRS) {
      checkpoint();
      // Ignore first: an entry git could see must never exist, not even for a crash's length.
      // Only names cezar may write: a recorded entry or a free path, never the user's own skill.
      const planned: string[] = [];
      for (const skill of skills) {
        const rel = `${agentDir}/skills/${skill.name}`;
        if (records.has(rel) || !(await lstat(join(worktree, rel)).catch(() => null))) planned.push(skill.name);
      }
      if (await landsInside(root, join(worktree, agentDir, 'skills', '.gitignore'))) {
        await syncIgnore(agentDir, [...ownedNames(agentDir), ...planned]);
      }
    }

    for (const skill of skills) {
      checkpoint();
      const plan = planFor(skill);
      if (plan.how === 'team') {
        // A record of another kind at a destination gives way first, while it is still ours.
        for (const agentDir of TEAM_SKILL_AGENT_DIRS) {
          const rel = `${agentDir}/skills/${skill.name}`;
          const record = records.get(rel);
          if (!record || record.kind === 'team-copy') continue;
          if (await ownedAt(worktree, record, contained)) await removePath(join(worktree, rel));
          records.delete(rel);
        }
        // A directory there without cezar's marker is the user's, even one replacing a copy.
        const written = await materializeSkillDir(worktree, skill, async () => undefined, { onlyOwned: true })
          .catch(() => [] as string[]);
        result.teamCopies[skill.name] = written;
        for (const dir of written) {
          const rel = `${basename(dirname(dirname(dir)))}/skills/${skill.name}`;
          wanted.add(rel);
          const identity = await identityOf(dir, 'team-copy');
          if (!identity?.startsWith('marker:')) continue;
          if (records.get(rel)?.identity !== identity) installed.add(skill.name);
          records.set(rel, { path: rel, kind: 'team-copy', skill: skill.name, identity });
        }
        await save();
        continue;
      }
      // A copy follows its source's content too, not only its path; digested only for a copy.
      let copyKey: Promise<string> | undefined;
      const copySource = () => (copyKey ??= plan.how === 'write'
        ? Promise.resolve(plan.source)
        : identityOf(plan.target, 'copy').then((digest) => `${plan.source}#${digest}`));
      for (const agentDir of TEAM_SKILL_AGENT_DIRS) {
        checkpoint();
        const rel = `${agentDir}/skills/${skill.name}`;
        const dest = join(worktree, rel);
        // The skills dir must land inside; the entry itself may be cezar's own link out of it.
        if (!(await contained(rel))) {
          records.delete(rel);
          continue;
        }
        const record = records.get(rel);
        const current = record ? await identityOf(dest, record.kind) : await lstat(dest).then(() => 'present', () => null);
        const source = record?.kind === 'copy' ? await copySource() : plan.source;
        if (record && record.kind !== 'pending' && current === record.identity && record.source === source) {
          wanted.add(rel);
          continue;
        }
        if (record && matches(record, current)) await removePath(dest);
        else if (record?.kind === 'pending' && current !== null) {
          // An interrupted entry that no longer matches: maybe the user's now. Leave it, ignored.
          wanted.add(rel);
          continue;
        } else if (current !== null) {
          // Not cezar's (tracked, or the user's own), or replaced since: leave it.
          records.delete(rel);
          continue;
        }
        const pending = async (identity: string, alternate?: string) => {
          records.set(rel, { path: rel, kind: 'pending', skill: skill.name, identity, ...(alternate ? { alternate } : {}) });
          await save();
        };
        await mkdir(dirname(dest), { recursive: true });
        let kind: ProvisionedEntry['kind'];
        if (plan.how === 'link-dir') {
          await pending(`link:${plan.target}`);
          kind = await makeLink(plan.target, dest, linkType).then(
            () => 'link' as const,
            async () => {
              await pending(`link:${plan.target}`, (await identityOf(plan.target, 'copy')) ?? undefined);
              await cp(plan.target, dest, { recursive: true, dereference: true });
              return 'copy' as const;
            },
          );
        } else if (plan.how === 'link-file') {
          await pending(treeIdentity([{ name: 'SKILL.md', link: plan.target }]));
          await mkdir(dest);
          kind = await makeLink(plan.target, join(dest, 'SKILL.md'), 'file').then(
            () => 'generated' as const,
            async () => {
              await pending(
                treeIdentity([{ name: 'SKILL.md', link: plan.target }]),
                treeIdentity([{ name: 'SKILL.md', content: await readFile(plan.target) }]),
              );
              await copyFile(plan.target, join(dest, 'SKILL.md'));
              return 'copy' as const;
            },
          );
        } else {
          await pending(treeIdentity([{ name: 'SKILL.md', content: plan.text }]));
          await mkdir(dest);
          await writeFile(join(dest, 'SKILL.md'), plan.text, 'utf8');
          kind = 'generated';
        }
        records.set(rel, {
          path: rel, kind, skill: skill.name, source: kind === 'copy' ? await copySource() : plan.source,
          identity: (await identityOf(dest, kind))!,
        });
        wanted.add(rel);
        installed.add(skill.name);
        await save();
      }
    }

    // Owned entries the closure no longer wants go, while they are still what cezar left.
    checkpoint();
    for (const record of [...records.values()]) {
      if (record.kind === 'ignore-file' || wanted.has(record.path)) continue;
      if (await ownedAt(worktree, record, contained)) await removePath(join(worktree, record.path));
      else if (record.kind === 'pending' && (await contained(record.path)) && (await lstat(join(worktree, record.path)).catch(() => null))) {
        continue; // changed since the interrupted pass: never deleted, still kept out of git
      }
      records.delete(record.path);
    }
    await save();
    for (const agentDir of TEAM_SKILL_AGENT_DIRS) await syncIgnore(agentDir, ownedNames(agentDir));

    result.installed = skills.map((skill) => skill.name).filter((name) => installed.has(name));
  } catch {
    // Best effort: the skill body still rides the system prompt.
  }
  return result;
}

/**
 * Remove every entry `provisionSkills` recorded in `worktree` that still is what cezar left, its
 * owned ignore files, and the record. A path the user replaced stays. Never throws. A later
 * skills design calls this before it installs its own view.
 */
export function removeProvisionedSkills(worktree: string): Promise<void> {
  return serialized(worktree, async () => {
    try {
      const gitDir = await gitDirOf(worktree);
      const root = await realpath(worktree).catch(() => null);
      if (!gitDir || root === null) return;
      const manifestFile = join(gitDir, MANIFEST_FILE);
      const manifest = await readManifest(manifestFile);
      const contained = (rel: string) => landsInside(root, dirname(join(worktree, rel)));
      for (const record of manifest.entries) {
        if (await ownedAt(worktree, record, contained)) await removePath(join(worktree, record.path));
      }
      await unlink(manifestFile).catch(() => undefined);
    } catch {
      // Best effort.
    }
  });
}

/** The recorded path still lands in the worktree and is what cezar left there. */
async function ownedAt(
  worktree: string,
  record: ProvisionedEntry,
  contained: (rel: string) => Promise<boolean>,
): Promise<boolean> {
  if (!(await contained(record.path))) return false;
  return matches(record, await identityOf(join(worktree, record.path), record.kind));
}
