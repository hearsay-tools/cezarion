import { productName, logPrefix } from './home/display.ts';
import type { Home } from './home/home.ts';
import { execFile } from 'node:child_process';
import { gitEnv } from './git-command.ts';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { DEFAULT_SKILLS_REF, loadConfig, readSkillsReposSync, type SkillsRepoRef } from './config.ts';
import { parseFrontmatter, type Skill } from './skills.ts';
import { isSafeSkillsRef, SKILLS_REPO_FORMATS, skillsRepoKind, type TeamSourceStatus } from '@open-mercato/cezar-contract/skill-sources';

/**
 * Global bare-clone skill cache, read through ls-tree/show. List and companion files use pinned
 * commit identity. Owned worktrees or the file cache receive materialized files; never the main
 * checkout. Network failure preserves local discovery.
 */

const LIST_TIMEOUT_MS = 10_000; // ls-tree / show / rev-parse
const CLONE_TIMEOUT_MS = 60_000; // clone / fetch

// ---- git plumbing ------------------------------------------------------------

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Restrict every remote-skill Git invocation to accepted transports. Disable ext/fd helpers and
 * interactive prompts; permit documented direct local sources without enabling recursive file
 * transport.
 */
const GIT_HARDENING_ARGS = [
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'protocol.fd.allow=never',
  '-c',
  'protocol.file.allow=user',
];
const GIT_HARDENING_ENV = {
  GIT_ALLOW_PROTOCOL: 'https:http:ssh:git:file',
  GIT_TERMINAL_PROMPT: '0',
};

function git(args: string[], timeoutMs: number, cwd?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...GIT_HARDENING_ARGS, ...args],
      {
        cwd,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        env: gitEnv(GIT_HARDENING_ENV),
      },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

/**
 * Normalize accepted shorthand, web, SSH and local skill sources. Reject option-like values,
 * remote-helper syntax and unsupported schemes before invoking Git; return null on refusal. The
 * accepted shapes are `skillsRepoKind`'s, the rule the Skills page's Add form also checks.
 */
export function safeRemoteFor(repo: string): string | null {
  const value = repo.trim();
  switch (skillsRepoKind(value)) {
    // git runs via execFile with no shell, so expand `~/` here or git would look for `~`.
    case 'home': return join(homedir(), value.slice(2));
    case 'github': return `https://github.com/${value}.git`;
    case 'local': case 'url': case 'scp': return value;
    default: return null;
  }
}

/** A ref safe to pass to `git` as a positional revision (hearsay-tools/cezarion#428); see `isSafeSkillsRef`. */
export const isSafeRef = isSafeSkillsRef;

/** A full commit SHA (sha-1 or sha-256) — a pinned, immutable ref (#428). */
export function isPinnedSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref) || /^[0-9a-f]{64}$/i.test(ref);
}

/** Stable cache key for a source: the last two path segments, `owner__name`. */
function cacheKeyFor(repo: string): string {
  const trimmed = repo
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^~\//, '');
  const segments = trimmed.split(/[/:]/).filter(Boolean).map(sanitizeSegment);
  return segments.slice(-2).join('__') || 'skills';
}

/** The source's bare clone: `~/.cache/cez/skills/<owner>__<name>`. */
export function bareDirFor(repo: string, home: Home): string {
  return join(home.skillsCache, cacheKeyFor(repo));
}

/**
 * Per-commit copies of the source's directory skills for runs without a task
 * worktree (#1024): `~/.cache/cez/skill-files/<owner>__<name>/<commit>/<skill>/`.
 */
export function skillFilesCacheDirFor(repo: string, home: Home): string {
  return join(home.skillFilesCache, cacheKeyFor(repo));
}

function sanitizeSegment(s: string): string {
  return s.replace(/[^\w.-]/g, '-');
}

/** One warning per bad source per process — this runs on every cockpit open. */
const warnedUnsafeRemotes = new Set<string>();

function warnUnsafeRemoteOnce(repo: string): void {
  if (warnedUnsafeRemotes.has(repo)) return;
  warnedUnsafeRemotes.add(repo);
  console.warn(
    `${logPrefix()} ignoring skills repo ${JSON.stringify(repo)} — not an accepted source shape ` +
      `(${SKILLS_REPO_FORMATS}). Check "skillsRepos" in the project's config.json (in .ai/squawk/, or .ai/cezar/ before the project moves), or remove it on the Skills page.`,
  );
}

/** Clone the skills repo bare (no checkout) into the global cache, once. */
export async function ensureBareClone(repo: string, home: Home): Promise<{ bareDir: string; created: boolean }> {
  // Validate before anything else, cache hit or not: "this source is refusable"
  // should never depend on whether a clone happens to exist already.
  const remote = safeRemoteFor(repo);
  if (!remote) {
    // Everything else in this module degrades silently (offline, no access —
    // all expected). A refusal is different: it means the config is wrong or
    // tampered with, and the operator otherwise just sees skills disappear.
    warnUnsafeRemoteOnce(repo);
    throw new Error(`refusing unsafe skills repo remote: ${repo}`);
  }
  const bareDir = bareDirFor(repo, home);
  if (existsSync(join(bareDir, 'HEAD'))) return { bareDir, created: false };
  await mkdir(dirname(bareDir), { recursive: true });
  // `--` separates options from the remote/dir operands: even a value that
  // slipped past validation can't pose as a git option.
  const res = await git(['clone', '--bare', '--', remote, bareDir], CLONE_TIMEOUT_MS);
  if (!res.ok) throw new Error(`git clone --bare ${remote} failed: ${res.stderr.trim()}`);
  return { bareDir, created: true };
}

/** "Refresh" — update every branch head in the bare clone from origin. */
export async function fetchAll(bareDir: string): Promise<void> {
  const res = await git(
    ['fetch', 'origin', '--prune', '+refs/heads/*:refs/heads/*'],
    CLONE_TIMEOUT_MS,
    bareDir,
  );
  if (!res.ok) throw new Error(`git fetch failed: ${res.stderr.trim() || res.stdout.trim()}`);
}

/**
 * Resolve a safe source ref to an immutable commit. A full SHA must name that exact commit and
 * never falls back to a moving ref. A branch or tag resolves as itself; only the default ref
 * (`main`) may fall back to `HEAD`.
 */
async function resolveRef(bareDir: string, ref: string): Promise<string | null> {
  if (!isSafeRef(ref)) return null;
  if (isPinnedSha(ref)) {
    const sha = ref.toLowerCase();
    const probe = await git(
      ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`],
      LIST_TIMEOUT_MS,
      bareDir,
    );
    // Pinned means pinned: only accept when rev-parse names exactly this commit.
    return probe.ok && probe.stdout.trim() === sha ? sha : null;
  }
  // Only the default ref falls back to the clone's HEAD, for a repo whose default branch is not
  // `main`. A ref someone chose that the repo lacks is an error, not the default branch's skills.
  const candidates = ref === DEFAULT_SKILLS_REF ? [ref, `refs/heads/${ref}`, 'HEAD'] : [ref, `refs/heads/${ref}`];
  for (const candidate of candidates) {
    const probe = await git(
      ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`],
      LIST_TIMEOUT_MS,
      bareDir,
    );
    if (probe.ok && probe.stdout.trim()) return probe.stdout.trim();
  }
  return null;
}

// ---- skill discovery (three conventions) --------------------------------------

interface SkillPathHit {
  /** null → the name comes from the file's frontmatter (markdown convention). */
  name: string | null;
  kind: 'skill' | 'command' | 'markdown';
}

/**
 * Match the janitor conventions plus our own:
 *  - `**\/SKILL.md`          → skill named after the parent directory (with references/)
 *  - `**\/commands/<n>.md`   → skill `<n>`
 *  - `.ai/skills/**\/*.md` or `.ai/cezar/skills/**\/*.md` → frontmatter/basename name
 */
function matchSkillPath(line: string): SkillPathHit | null {
  if (line === 'SKILL.md' || line.endsWith('/SKILL.md')) {
    const parts = line.split('/');
    if (parts.length < 2) return null;
    const parent = parts[parts.length - 2];
    return parent && parent !== '.' ? { name: parent, kind: 'skill' } : null;
  }
  const cmd = /(?:^|\/)commands\/([^/]+)\.md$/.exec(line);
  if (cmd) return { name: cmd[1] as string, kind: 'command' };
  if (/(?:^|\/)\.ai\/(?:(?:cezar|squawk)\/)?skills\/.+\.md$/.test(line)) return { name: null, kind: 'markdown' };
  return null;
}

/**
 * Read one file from the bare clone at the source's ref. Null on any failure.
 * `atCommit` pins the read to an already-resolved commit, so a caller listing
 * many files reads them all at the same commit (and skips re-resolving).
 */
export async function readRemoteSkill(
  src: SkillsRepoRef,
  path: string,
  atCommit: string | undefined,
  home: Home,
): Promise<string | null> {
  const bareDir = bareDirFor(src.repo, home);
  if (!existsSync(join(bareDir, 'HEAD'))) return null;
  const ref = atCommit ?? (await resolveRef(bareDir, src.ref));
  if (ref === null) return null;
  const res = await git(['show', `${ref}:${path}`], LIST_TIMEOUT_MS, bareDir);
  return res.ok ? res.stdout : null;
}

/**
 * List every skill the repo defines at `src.ref`. Reads from the local bare
 * clone only — no network. Empty list when the clone doesn't exist yet or
 * the ref can't be resolved.
 */
export async function listRemoteSkills(src: SkillsRepoRef, home: Home): Promise<Skill[]> {
  return (await listRemoteSource(src, home)).skills;
}

/** Why a listing came back empty: no clone on disk yet, a ref the clone cannot resolve, or a
 *  `git ls-tree` that failed on a resolved ref. */
type ListProblem = 'no-clone' | 'ref-not-found' | 'list-failed' | null;

async function listRemoteSource(src: SkillsRepoRef, home: Home): Promise<{ skills: Skill[]; problem: ListProblem }> {
  const bareDir = bareDirFor(src.repo, home);
  if (!existsSync(join(bareDir, 'HEAD'))) return { skills: [], problem: 'no-clone' };
  // An immutable SHA (#428): the tree listing and every body below are read at
  // this one commit, and it is what gets recorded on each skill.
  const commit = await resolveRef(bareDir, src.ref);
  if (commit === null) return { skills: [], problem: 'ref-not-found' };
  // `--` after the ref keeps a `-`-leading value out of git's option surface.
  const ls = await git(['ls-tree', '-r', '--name-only', commit, '--'], LIST_TIMEOUT_MS, bareDir);
  if (!ls.ok) return { skills: [], problem: 'list-failed' };

  const skills: Skill[] = [];
  const seen = new Set<string>();
  for (const line of ls.stdout.split('\n')) {
    if (!line) continue;
    const hit = matchSkillPath(line);
    if (!hit) continue;
    const raw = await readRemoteSkill(src, line, commit, home);
    if (raw === null) continue;
    const { frontmatter, body } = parseFrontmatter(raw);
    const name =
      hit.name ??
      (typeof frontmatter.name === 'string' && frontmatter.name.trim()
        ? frontmatter.name.trim()
        : basename(line, '.md'));
    if (seen.has(name)) continue;
    seen.add(name);
    const description =
      typeof frontmatter.description === 'string' && frontmatter.description.trim()
        ? frontmatter.description.trim()
        : undefined;
    skills.push({
      name,
      description,
      body,
      path: `${src.repo}@${src.ref}:${line}`,
      source: 'team',
      team: { repo: src.repo, ref: src.ref, path: line, dir: hit.kind === 'skill', commit },
    });
  }
  return { skills, problem: null };
}

// ---- materialization (directory skills) ---------------------------------------

/**
 * Dropped into every copy `materializeSkillDir` creates, recording where it came
 * from. Its presence is what makes a directory Squawk's to replace: a skill dir
 * without it may be the user's own, and is only ever overlaid.
 */
const TEAM_SKILL_MARKER = '.cezar-team-skill.json';

interface SkillDirSource {
  bareDir: string;
  /** The immutable commit the files are read at. */
  commit: string;
  /** The skill's directory inside the skills repo. */
  srcDir: string;
}

/**
 * Locate directory skill files at the body’s recorded commit. Resolve the source ref only for a
 * legacy missing commit or a clone that no longer holds it.
 */
async function resolveSkillDirSource(skill: Skill, home: Home): Promise<SkillDirSource | null> {
  if (!skill.team?.dir || !skill.team.path.endsWith('SKILL.md')) return null;
  const bareDir = bareDirFor(skill.team.repo, home);
  if (!existsSync(join(bareDir, 'HEAD'))) return null;
  const listed = skill.team.commit && isPinnedSha(skill.team.commit) ? await resolveRef(bareDir, skill.team.commit) : null;
  const commit = listed ?? (await resolveRef(bareDir, skill.team.ref));
  if (commit === null) return null;
  return { bareDir, commit, srcDir: skill.team.path.slice(0, -'/SKILL.md'.length) };
}

/** Every file of the skill's directory at the commit, keyed by its `/`-joined relative path. */
async function readSkillDirFiles({ bareDir, commit, srcDir }: SkillDirSource): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const ls = await git(['ls-tree', '-r', '--name-only', commit, '--', srcDir], LIST_TIMEOUT_MS, bareDir);
  if (!ls.ok) return files;
  for (const file of ls.stdout.split('\n').filter(Boolean)) {
    const rel = file.slice(srcDir.length + 1);
    // git paths are repo-relative and normalized, but never trust them blindly.
    if (!rel || rel.split('/').includes('..') || rel === TEAM_SKILL_MARKER) continue;
    const show = await git(['show', `${commit}:${file}`], LIST_TIMEOUT_MS, bareDir);
    if (show.ok) files.set(rel, show.stdout);
  }
  return files;
}

/**
 * Where `path` really lands: the realpath of its nearest existing ancestor (the
 * path itself when it exists), through every symlink, plus the segments below
 * it. Null when that ancestor cannot be resolved, a dangling link among them.
 */
async function landingPath(path: string): Promise<string | null> {
  const below: string[] = [];
  for (let at = resolve(path); ; at = dirname(at)) {
    if (await lstat(at).then(() => true, () => false)) {
      const real = await realpath(at).catch(() => null);
      return real === null ? null : join(real, ...below.reverse());
    }
    if (dirname(at) === at) return null;
    below.push(basename(at));
  }
}

/** `path` lands inside `root`, itself a realpath. */
export async function landsInside(root: string, path: string): Promise<boolean> {
  const landing = await landingPath(path);
  return landing !== null && (landing === root || landing.startsWith(root.endsWith(sep) ? root : root + sep));
}

/** Write every file under `destDir`; given a `root`, skip a file that would land outside it. */
async function writeSkillFiles(destDir: string, files: Map<string, string>, root?: string): Promise<void> {
  for (const [rel, content] of files) {
    const target = join(destDir, rel);
    if (root !== undefined && !(await landsInside(root, target))) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

/**
 * Clear the paths in `dir` whose type the new files contradict: a directory or a
 * symlink where a file goes, and a non-directory (a symlink included) where a
 * file's parent directory goes. Without this an upstream `references/guide` that
 * became `references/guide/x.md` (or back) fails the write with EEXIST/EISDIR,
 * and a write follows a link wherever it points. Only for a marked copy. Every
 * check is an lstat, so a link is unlinked, never followed.
 */
async function clearTypeConflicts(dir: string, files: Map<string, string>): Promise<void> {
  const entry = (path: string) => lstat(path).catch(() => null);
  for (const rel of files.keys()) {
    const parts = rel.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      const ancestor = join(dir, ...parts.slice(0, depth));
      if ((await entry(ancestor))?.isDirectory() === false) await unlink(ancestor);
    }
    const target = join(dir, rel);
    const found = await entry(target);
    if (found?.isDirectory()) await rm(target, { recursive: true, force: true });
    else if (found?.isSymbolicLink()) await unlink(target);
  }
}

/** Remove every entry under `dir` whose `/`-joined relative path is not kept, then empty directories. */
async function removeUnlisted(dir: string, keep: Set<string>, prefix = ''): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await removeUnlisted(path, keep, rel);
      await rmdir(path).catch(() => undefined); // still holds kept files
    } else if (!keep.has(rel)) {
      await unlink(path);
    }
  }
}

/** Where `materializeSkillDir` puts a worktree copy: `<dir>/skills/<name>/`, in this order. */
export const TEAM_SKILL_AGENT_DIRS = ['.claude', '.agents', '.cursor'] as const;

/**
 * Copy a directory skill and its companion files into TEAM_SKILL_AGENT_DIRS under `repoRoot`,
 * excluding destinations from Git. Return only written directories and preserve containment.
 * Task provisioning (`skills-provision.ts`) passes a staging dir and places each copy itself,
 * through the worktree's manifest.
 */
export async function materializeSkillDir(
  repoRoot: string,
  skill: Skill,
  /** Keeps one written copy out of git; defaults to the shared `info/exclude`. */
  ignore: (agentDir: string) => Promise<void> = (agentDir) => excludeFromGit(repoRoot, `${agentDir}/skills/${skill.name}/`),
  home: Home,
): Promise<string[]> {
  const source = await resolveSkillDirSource(skill, home);
  if (!source || !skill.team) return [];
  const files = await readSkillDirFiles(source);
  if (files.size === 0) return [];
  const { repo, ref, path } = skill.team;
  const marker = `${JSON.stringify({ repo, ref, path, commit: source.commit }, null, 2)}\n`;

  const root = await realpath(repoRoot).catch(() => null);
  if (root === null) return [];
  const written: string[] = [];
  for (const agentDir of TEAM_SKILL_AGENT_DIRS) {
    const destDir = join(repoRoot, agentDir, 'skills', skill.name);
    if (!(await landsInside(root, destDir))) continue;
    // lstat: a marker that is a link elsewhere does not make the dir ours.
    const marked = (await lstat(join(destDir, TEAM_SKILL_MARKER)).catch(() => null))?.isFile() === true;
    const ours = !existsSync(destDir) || marked;
    if (ours) {
      await mkdir(destDir, { recursive: true });
      await writeFile(join(destDir, TEAM_SKILL_MARKER), marker, 'utf8');
      await clearTypeConflicts(destDir, files);
    }
    await writeSkillFiles(destDir, files, root);
    if (ours) await removeUnlisted(destDir, new Set([...files.keys(), TEAM_SKILL_MARKER]));
    written.push(agentDir);
  }
  for (const agentDir of written) await ignore(agentDir);
  return written.map((agentDir) => resolve(repoRoot, agentDir, 'skills', skill.name));
}

/** A per-commit copy nobody has used for this long is pruned. */
const SKILL_FILES_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Materialize directory skill files in the commit-keyed cache for runs without an owned
 * worktree. Stage then rename complete copies, prune unused old commits and return null on
 * failure. Never write project files or info/exclude.
 */
export async function materializeSkillToCache(skill: Skill, home: Home): Promise<string | null> {
  try {
    const source = await resolveSkillDirSource(skill, home);
    if (!source || !skill.team) return null;
    const root = skillFilesCacheDirFor(skill.team.repo, home);
    const commitDir = join(root, source.commit);
    const dest = join(commitDir, skill.name);
    if (!existsSync(dest)) {
      const files = await readSkillDirFiles(source);
      if (files.size === 0) return null;
      const staging = join(commitDir, `.${skill.name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
      try {
        await mkdir(staging, { recursive: true });
        await writeSkillFiles(staging, files);
        await rename(staging, dest);
      } catch (error) {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        // A concurrent writer renamed the same commit's copy into place first.
        if (!existsSync(dest)) throw error;
      }
    }
    const now = new Date();
    await utimes(commitDir, now, now);
    await pruneSkillFiles(root, source.commit, now.getTime());
    return dest;
  } catch {
    return null;
  }
}

/** Best-effort: drop the source's commit dirs other than `keep` untouched for a week. */
async function pruneSkillFiles(root: string, keep: string, now: number): Promise<void> {
  for (const entry of await readdir(root).catch(() => [] as string[])) {
    if (entry === keep) continue;
    const path = join(root, entry);
    try {
      if (now - (await stat(path)).mtimeMs > SKILL_FILES_TTL_MS) await rm(path, { recursive: true, force: true });
    } catch {
      // raced with another pruner, or unreadable — the next run tries again
    }
  }
}

/** Append a pattern to git's `info/exclude` (idempotent, non-fatal). */
export async function excludeFromGit(repoRoot: string, pattern: string): Promise<void> {
  try {
    // Resolve the real exclude file: in a linked worktree (spec 006) `.git`
    // is a file and `info/exclude` lives in the shared common dir — which
    // also means one exclude entry covers every task worktree.
    const probe = await git(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      LIST_TIMEOUT_MS,
      repoRoot,
    );
    const gitDir = probe.ok && probe.stdout.trim() ? probe.stdout.trim() : join(repoRoot, '.git');
    const excludePath = join(gitDir, 'info', 'exclude');
    let prev = '';
    try {
      prev = await readFile(excludePath, 'utf8');
    } catch {
      // no exclude file yet
    }
    if (prev.split('\n').includes(pattern)) return;
    await mkdir(dirname(excludePath), { recursive: true });
    await writeFile(excludePath, prev + (prev && !prev.endsWith('\n') ? '\n' : '') + pattern + '\n', 'utf8');
  } catch {
    // non-fatal — `.git` might be a linked file (worktree) or absent entirely
  }
}

// ---- in-process cache ----------------------------------------------------------

// A failed clone/fetch is expensive when the network is down (git can hang on
// DNS/TCP), so each source gets one implicit retry budget per process. Success
// is recorded on disk (the stamp) so a later TTL expiry in this process can
// still fetch. "Refresh" always retries.
const cloneAttempted = new Set<string>();
// One in-flight clone/fetch per source so two project roots that share a
// skills repo cannot both start a fetch and have the loser mark the source
// failed after the winner already stamped it.
const fetchInFlight = new Map<string, Promise<void>>();
// Share the passive-fetch TTL stamp across processes using unique-temp atomic writes.
// Explicit refresh still fetches unconditionally; fresh worktrees can read the bare cache.
const PASSIVE_FETCH_TTL_MS = 6 * 60 * 60 * 1_000;
const LAST_FETCH_STAMP = 'cez-last-fetch';

/** Path of the last-fetch stamp that lives inside a bare clone directory. */
export function lastFetchStampPath(bareDir: string): string {
  return join(bareDir, LAST_FETCH_STAMP);
}

/**
 * Last successful fetch time for this bare clone, or `null` when the stamp is
 * missing or unreadable. Fail-open: a corrupt stamp is treated as stale.
 */
export function readLastFetchAt(bareDir: string): number | null {
  try {
    const n = Number(readFileSync(lastFetchStampPath(bareDir), 'utf8').trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Persist a last-fetch time inside `bareDir`. Unique tmp + rename (the same
 * cross-process write discipline as workspace config). Fail-open on a
 * read-only cache: listing still works, the next process may fetch again.
 */
export async function writeLastFetchAt(bareDir: string, at: number): Promise<void> {
  const path = lastFetchStampPath(bareDir);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${at}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, path);
  } catch {
    try {
      await unlink(tmp);
    } catch {
      // staging file may never have been created
    }
  }
}

/**
 * Whether a passive (non-`refresh`) load should `git fetch`: yes when there is
 * no stamp, and yes once the stamp is older than `ttlMs`. Pure so the
 * freshness policy is unit-tested without git.
 */
export function shouldPassiveFetch(opts: {
  fetchedAt: number | null;
  now: number;
  ttlMs: number;
}): boolean {
  return opts.fetchedAt == null || opts.now - opts.fetchedAt > opts.ttlMs;
}

/**
 * A failed clone/fetch is sticky only while the stamp is still missing or
 * stale. A concurrent sibling that already wrote a fresh stamp must not be
 * recorded as a local failure — that would suppress the next TTL in this
 * process (#367 review).
 */
export function shouldRecordFetchFailure(opts: {
  fetchedAt: number | null;
  now: number;
  ttlMs: number;
}): boolean {
  return shouldPassiveFetch(opts);
}

/** Test hook: simulate a process-local failed attempt for this source. */
export function __markCloneAttemptedForTests(repo: string, home: Home): void {
  cloneAttempted.add(bareDirFor(repo, home));
}

/** Test hook: hold this source's clone/fetch open until `until` settles (#859). */
export function __holdFetchForTests(repo: string, until: Promise<void>, home: Home): void {
  const held = until.finally(() => {
    if (fetchInFlight.get(bareDirFor(repo, home)) === held) fetchInFlight.delete(bareDirFor(repo, home));
  });
  fetchInFlight.set(bareDirFor(repo, home), held);
}

const cachedListPauses = new Map<string, { reached: () => void; until: Promise<void> }>();

/**
 * Test hook: park this project's next passive load right after its list-only
 * pass until `until` settles (#859). Resolves once the load has parked there.
 */
export function __pauseAfterCachedListForTests(repoRoot: string, until: Promise<void>, home: Home): Promise<void> {
  return new Promise((reached) => { cachedListPauses.set(teamCacheKey(repoRoot, home), { reached, until }); });
}

// Both maps are keyed by `repoRoot` (multi-project workspace, step 2.6): each
// project resolves its own `.ai/cezar/config.json` → `skillsRepos`, so one
// project's team-skill list must never be served under another project's scope.
function teamCacheKey(repoRoot: string, home: Home): string { return JSON.stringify([repoRoot, home.skillsCache]); }

const teamSkillsByRoot = new Map<string, Skill[]>();
const firstLoadByRoot = new Map<string, Promise<Skill[]>>();
// The first load's list-only pass over the clones already on disk (#859).
const cachedListByRoot = new Map<string, Promise<Skill[]>>();
// Bumped by every post-fetch publication, so a list-only pass that finishes
// late never replaces a newer list (a concurrent refresh) in `teamSkillsByRoot`.
const postFetchListsByRoot = new Map<string, number>();

function initialTeamSkillsLoad(repoRoot: string, home: Home): Promise<Skill[]> {
  const existing = firstLoadByRoot.get(teamCacheKey(repoRoot, home));
  if (existing) return existing;
  let listed!: (skills: Skill[]) => void;
  cachedListByRoot.set(teamCacheKey(repoRoot, home), new Promise((resolve) => { listed = resolve; }));
  const load = loadTeamSkills(repoRoot, 'passive', listed, home).catch(() => teamSkillsByRoot.get(teamCacheKey(repoRoot, home)) ?? []);
  // A load that failed before its list-only pass still settles the cached wait.
  void load.then((skills) => listed(skills));
  firstLoadByRoot.set(teamCacheKey(repoRoot, home), load);
  return load;
}

/**
 * The current team-skill list for this project, straight from memory: one entry per source and
 * name, in source order, so one name can appear once per source (see `mergeSourceLists`). The
 * first call per `repoRoot` kicks off an async background load (clone + list)
 * and returns immediately — the GUI refetches, so remote skills appear moments
 * later instead of blocking the first `GET /api/skills`.
 */
export function getTeamSkillsCached(repoRoot: string, home: Home): Skill[] {
  void initialTeamSkillsLoad(repoRoot, home);
  return teamSkillsByRoot.get(teamCacheKey(repoRoot, home)) ?? [];
}

/**
 * Wait for the same non-refreshing load kicked off by `getTeamSkillsCached`.
 * The normal catalog read stays immediate; callers use this only for a
 * background convergence read after they have already rendered local skills.
 */
export function waitForTeamSkills(repoRoot: string, home: Home): Promise<Skill[]> {
  return initialTeamSkillsLoad(repoRoot, home);
}

/**
 * The first load's list of the bare clones already on disk, published before
 * any passive fetch (#859). Never waits on the network: no clone yet means an
 * empty list, not a clone. When a refresh started this project's first load
 * there is no list-only pass, and this answers with the current list.
 */
export function waitForCachedTeamSkills(repoRoot: string, home: Home): Promise<Skill[]> {
  void initialTeamSkillsLoad(repoRoot, home);
  return cachedListByRoot.get(teamCacheKey(repoRoot, home)) ?? Promise.resolve(teamSkillsByRoot.get(teamCacheKey(repoRoot, home)) ?? []);
}

/** Refresh: clone missing sources, `git fetch` existing ones, reload the list. */
export async function refreshTeamSkills(repoRoot: string, home: Home): Promise<Skill[]> {
  return publishLoad(repoRoot, 'all', home);
}

/**
 * Fetch only the named sources, then reload the list (hearsay-tools/cezarion#279): the Skills page's Add and Retry.
 * The other sources are listed from their clones as they are, with no fetch.
 */
export async function refreshTeamSources(repoRoot: string, sources: readonly SkillsRepoRef[], home: Home): Promise<Skill[]> {
  // Loading from this call on, so the answer that started the fetch already says so.
  for (const src of sources) setSourceStatus(repoRoot, src, { state: 'loading' }, home);
  return publishLoad(repoRoot, { only: new Set(sources.map(sourceKey)) }, home);
}

/**
 * Reload the list from the clones on disk with no fetch (hearsay-tools/cezarion#279), after a source was removed,
 * disabled or enabled, so the change shows at once.
 */
export async function reloadTeamSkills(repoRoot: string, home: Home): Promise<Skill[]> {
  return publishLoad(repoRoot, 'none', home);
}

function publishLoad(repoRoot: string, mode: Exclude<FetchMode, 'passive'>, home: Home): Promise<Skill[]> {
  const load = loadTeamSkills(repoRoot, mode, undefined, home).catch(() => teamSkillsByRoot.get(teamCacheKey(repoRoot, home)) ?? []);
  firstLoadByRoot.set(teamCacheKey(repoRoot, home), load);
  return load;
}

/** How a load fetches: by TTL, every source, the named sources only, or none. */
type FetchMode = 'passive' | 'all' | 'none' | { only: ReadonlySet<string> };

/** A source's identity. Two refs of one repo are two sources. */
export function sourceKey(src: SkillsRepoRef): string {
  return JSON.stringify([src.repo, src.ref]);
}

// The last fetch failure per repo, cleared by the next good fetch. A passive load that does not
// fetch keeps showing it, so the Skills page does not call a source fine until it is.
const fetchFailures = new Map<string, string>();
// Each project's source states, keyed by `sourceKey` (hearsay-tools/cezarion#279).
const sourceStatusByRoot = new Map<string, Map<string, TeamSourceStatus>>();

/**
 * Each configured source's state for this project, as the last load left it. A source no load
 * has reached yet is absent; the caller shows it as `idle`.
 */
export function getTeamSourceStatuses(repoRoot: string, home: Home): ReadonlyMap<string, TeamSourceStatus> {
  void initialTeamSkillsLoad(repoRoot, home);
  return sourceStatusByRoot.get(teamCacheKey(repoRoot, home)) ?? new Map();
}

function setSourceStatus(repoRoot: string, src: SkillsRepoRef, status: TeamSourceStatus, home: Home): void {
  let statuses = sourceStatusByRoot.get(teamCacheKey(repoRoot, home));
  if (!statuses) sourceStatusByRoot.set(teamCacheKey(repoRoot, home), (statuses = new Map()));
  statuses.set(sourceKey(src), status);
}

/** The state a listed source ends a load in. Its listed skills stay usable whatever it says. */
function settledStatus(src: SkillsRepoRef, skills: Skill[], problem: ListProblem, home: Home): TeamSourceStatus {
  const skillCount = skills.length;
  if (safeRemoteFor(src.repo) === null) {
    return { state: 'error', cause: 'refused-format', detail: `"${src.repo}" is not a source format ${productName('cezar')} accepts.`, skillCount };
  }
  const failure = fetchFailures.get(bareDirFor(src.repo, home));
  if (failure !== undefined) return { state: 'error', cause: 'fetch-failed', detail: failure, skillCount };
  if (problem === 'ref-not-found') {
    return { state: 'error', cause: 'ref-not-found', detail: `The ref "${src.ref}" was not found in ${src.repo}.`, skillCount };
  }
  if (problem === 'list-failed') {
    return { state: 'error', cause: 'fetch-failed', detail: `git could not list the skills of ${src.repo} at ${src.ref}.`, skillCount };
  }
  if (problem === 'no-clone') return { state: 'idle' };
  return { state: 'ok', skillCount };
}

function stampIsFresh(repo: string, now: number, home: Home): boolean {
  return !shouldPassiveFetch({
    fetchedAt: readLastFetchAt(bareDirFor(repo, home)),
    now,
    ttlMs: PASSIVE_FETCH_TTL_MS,
  });
}

/** Clone/fetch one source, coalesced across concurrent catalog loads. */
function fetchBareSource(repo: string, home: Home): Promise<void> {
  const existing = fetchInFlight.get(bareDirFor(repo, home));
  if (existing) return existing;
  const work = Promise.resolve()
    .then(async () => {
      const { bareDir, created } = await ensureBareClone(repo, home);
      if (!created) await fetchAll(bareDir);
      await writeLastFetchAt(bareDir, Date.now());
      cloneAttempted.delete(bareDirFor(repo, home));
      fetchFailures.delete(bareDirFor(repo, home));
    })
    .catch((error: unknown) => {
      fetchFailures.set(bareDirFor(repo, home), error instanceof Error ? error.message : String(error));
      // A concurrent sibling may already have written a fresh stamp. Recording
      // that as a local failure would suppress the next TTL in this process.
      if (shouldRecordFetchFailure({
        fetchedAt: readLastFetchAt(bareDirFor(repo, home)),
        now: Date.now(),
        ttlMs: PASSIVE_FETCH_TTL_MS,
      })) {
        cloneAttempted.add(bareDirFor(repo, home));
      }
      throw error;
    })
    .finally(() => {
      if (fetchInFlight.get(bareDirFor(repo, home)) === work) fetchInFlight.delete(bareDirFor(repo, home));
    });
  fetchInFlight.set(bareDirFor(repo, home), work);
  return work;
}

/**
 * Every source's copy of a name, in configured source order (#1494). Only an exact source and
 * name repeat (one `repo` listed at two refs) collapses, to the first. Name precedence is
 * `discoverSkills`'s, which applies the project's off-list first: switching one source's copy
 * off must leave the next source's copy to win.
 */
function mergeSourceLists(lists: Array<Skill[] | undefined>): Skill[] {
  const out: Skill[] = [];
  const seen = new Set<string>();
  for (const skill of lists.flatMap((list) => list ?? [])) {
    const key = JSON.stringify([skill.team?.repo, skill.name]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(skill);
  }
  return out;
}

async function loadTeamSkills(
  repoRoot: string,
  mode: FetchMode,
  onCachedList: ((skills: Skill[]) => void) | undefined,
  home: Home,
): Promise<Skill[]> {
  // A disabled source stays in the file and loads nothing (hearsay-tools/cezarion#279).
  const sources = (await loadConfig(repoRoot, home)).skillsRepos.filter((src) => src.enabled);
  forgetUnlistedStatuses(repoRoot, sources, home);
  // Passive loads list the clones already on disk BEFORE any fetch (#859): the
  // first restart past the TTL otherwise hides every team skill — and starves a
  // recovered Continue of its playbook — for as long as the fetch takes.
  let cached: Array<Skill[] | undefined> = [];
  // Each source's stamp as the snapshot saw it. The bare clone and its stamp
  // are shared by every project and process, so a fetch made for another
  // project never bumps this one's generation; a moved stamp is how it shows.
  let snapshotStamps: Array<number | null> = [];
  const generation = postFetchListsByRoot.get(teamCacheKey(repoRoot, home)) ?? 0;
  // True once another load has published a post-fetch list since this one
  // started: its snapshot may predate that list, so it must not win (#859).
  const superseded = () => {
    return (postFetchListsByRoot.get(teamCacheKey(repoRoot, home)) ?? 0) !== generation;
  };
  if (mode === 'passive') {
    snapshotStamps = sources.map((src) => readLastFetchAt(bareDirFor(src.repo, home)));
    cached = await Promise.all(sources.map((src) => listRemoteSkills(src, home).catch(() => undefined)));
    const pause = cachedListPauses.get(teamCacheKey(repoRoot, home));
    if (pause) {
      cachedListPauses.delete(teamCacheKey(repoRoot, home));
      pause.reached();
      await pause.until;
    }
    const listed = mergeSourceLists(cached);
    if (!superseded()) teamSkillsByRoot.set(teamCacheKey(repoRoot, home), listed);
    onCachedList?.(listed);
  }
  const lists: Array<Skill[] | undefined> = [];
  for (const [index, src] of sources.entries()) {
    // An unfetched source has not moved since the list-only pass unless
    // another load fetched it meanwhile; reuse the snapshot only then.
    const snapshot = { skills: cached[index], stamp: snapshotStamps[index], superseded };
    lists.push(await loadOneSource(repoRoot, src, mode, snapshot, home));
  }
  // A source removed or disabled while this load fetched leaves the list it publishes: an older
  // Retry must not bring back a source a newer change took out.
  const current = new Set(readEnabledSourceKeys(repoRoot));
  const out = mergeSourceLists(lists).filter((skill) => !skill.team || current.has(sourceKey(skill.team)));
  forgetUnlistedStatuses(repoRoot, sources.filter((src) => current.has(sourceKey(src))), home);
  // Every load but a passive one publishes. A passive load that a newer post-fetch list
  // overtook defers to it rather than replacing it with an older view.
  if (mode === 'passive' && superseded()) return teamSkillsByRoot.get(teamCacheKey(repoRoot, home)) ?? out;
  postFetchListsByRoot.set(teamCacheKey(repoRoot, home), (postFetchListsByRoot.get(teamCacheKey(repoRoot, home)) ?? 0) + 1);
  teamSkillsByRoot.set(teamCacheKey(repoRoot, home), out);
  return out;
}

/** The enabled `skillsRepos` entries as the file says now, read synchronously at publish time. */
function readEnabledSourceKeys(repoRoot: string): string[] {
  return readSkillsReposSync(repoRoot).filter((src) => src.enabled).map(sourceKey);
}

/** Fetch `src` when the mode says so, list it, and record its state. */
async function loadOneSource(
  repoRoot: string,
  src: SkillsRepoRef,
  mode: FetchMode,
  snapshot: { skills: Skill[] | undefined; stamp: number | null | undefined; superseded: () => boolean },
  home: Home,
): Promise<Skill[] | undefined> {
  const now = Date.now();
  if (stampIsFresh(src.repo, now, home)) cloneAttempted.delete(bareDirFor(src.repo, home));
  const fetched = shouldFetchSource(mode, src, now, home);
  if (fetched) {
    setSourceStatus(repoRoot, src, { state: 'loading' }, home);
    // offline / no access — list whatever an older clone has (or nothing); the status says why
    await fetchBareSource(src.repo, home).catch(() => undefined);
  }
  const unmoved = !snapshot.superseded() && readLastFetchAt(bareDirFor(src.repo, home)) === snapshot.stamp;
  const reused = fetched || !unmoved ? undefined : snapshot.skills;
  // degrade: a source that fails to list contributes nothing. A non-empty snapshot needs no
  // second listing; an empty one is listed again only to learn why it is empty.
  const result = reused?.length ? { skills: reused, problem: null } : await listRemoteSource(src, home).catch(() => undefined);
  const listed = reused ?? result?.skills;
  setSourceStatus(repoRoot, src, settledStatus(src, listed ?? [], result?.problem ?? null, home), home);
  return listed;
}

/** Whether this load fetches `src`: always, by name, or by the passive TTL and retry budget. */
function shouldFetchSource(mode: FetchMode, src: SkillsRepoRef, now: number, home: Home): boolean {
  if (mode === 'all') return true;
  if (mode === 'none') return false;
  if (mode !== 'passive') return mode.only.has(sourceKey(src));
  return shouldPassiveFetch({ fetchedAt: readLastFetchAt(bareDirFor(src.repo, home)), now, ttlMs: PASSIVE_FETCH_TTL_MS })
    && !cloneAttempted.has(bareDirFor(src.repo, home));
}

/** Drop the state of a source that is no longer an enabled entry in `skillsRepos`. */
function forgetUnlistedStatuses(repoRoot: string, sources: readonly SkillsRepoRef[], home: Home): void {
  const statuses = sourceStatusByRoot.get(teamCacheKey(repoRoot, home));
  if (!statuses) return;
  const keep = new Set(sources.map(sourceKey));
  for (const key of statuses.keys()) if (!keep.has(key)) statuses.delete(key);
}
