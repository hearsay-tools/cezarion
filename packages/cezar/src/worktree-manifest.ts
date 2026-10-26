import { execFile } from 'node:child_process';
import { createHash, randomBytes, type Hash } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { landsInside } from './skills-remote.ts';

const execFileAsync = promisify(execFile);

/**
 * The record of every path cezar wrote into a task worktree (hearsay-tools/cezarion#1814), for
 * every module that writes there (`.ai/ast-grep/rules/worktree-write-outside-manifest.yml` names
 * them). It lives in the worktree's private git dir, so it dies with the worktree and nothing in
 * the tree (a tool, a diff, autosave) sees it. A writer replaces or removes a path only while the
 * manifest lists it for that writer and the path still is what cezar left there, so a file the
 * agent changed or added stays. A missing or unreadable manifest lists nothing: every file stays.
 */
export const MANIFEST_FILE = 'cezar-manifest.json';

/** The skills-only record before hearsay-tools/cezarion#1814: imported for paths the manifest
 *  does not list, then removed once a manifest holding them is saved. */
export const LEGACY_SKILLS_MANIFEST_FILE = 'cezar-skills.json';

const MANIFEST_VERSION = 1;
const STAGING_DIR = 'cezar-staging';

export type ManifestWriter = 'skills' | 'seed';
export type EntryKind = 'link' | 'copy' | 'generated' | 'team-copy' | 'ignore-file' | 'file';
const KINDS: ReadonlySet<string> = new Set<string>(['link', 'copy', 'generated', 'team-copy', 'ignore-file', 'file', 'pending']);

/** `/`-joined and below the worktree: no root, no `.` or `..`, no empty segment. */
const entryPath = z.string().refine(
  (path) => !path.includes('\\') && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
);

/** Unknown keys stay, so a rewrite keeps what a newer cezar of the same version added. */
const entrySchema = z.object({
  path: entryPath,
  /** One writer per path: another writer's entry is never acted on. */
  writer: z.string(),
  /** `pending` is saved before a write, with the identity the write leaves; the final kind replaces it. */
  kind: z.string(),
  skill: z.string().optional(),
  /** What the entry was made from: a changed source means a rewrite. */
  source: z.string().optional(),
  /**
   * What cezar left at the path: `link:<target>`, or `tree2:<sha256>` over every name, link target
   * and byte, each length-prefixed, and each file's executable bit. A `tree:` identity is an
   * imported one in the older encoding.
   */
  identity: z.string(),
  /** A pending entry's other complete form that still counts as cezar's: the copy it replaces. */
  alternate: z.string().optional(),
}).passthrough();
export type ManifestEntry = z.infer<typeof entrySchema>;

const manifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  entries: z.array(z.unknown()),
  skills: z.object({ roots: z.array(z.unknown()).optional() }).passthrough().optional(),
}).passthrough();

const legacySchema = z.object({ version: z.literal(1), roots: z.array(z.unknown()), entries: z.array(z.unknown()) });
const legacyEntrySchema = entrySchema.omit({ writer: true });

interface Loaded {
  /** Top-level keys this cezar does not know, written back unchanged. */
  extra: Record<string, unknown>;
  skillsExtra: Record<string, unknown>;
  entries: ManifestEntry[];
  roots: string[];
  /** A legacy record was imported: it is removed after the manifest that holds it is saved. */
  legacy: boolean;
}

async function readJson(file: string): Promise<{ found: false } | { found: true; value: unknown }> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { found: false };
  }
  try {
    return { found: true, value: JSON.parse(text) as unknown };
  } catch {
    return { found: true, value: undefined };
  }
}

function strings(values: readonly unknown[] | undefined): string[] {
  return (values ?? []).filter((value): value is string => typeof value === 'string');
}

/** The manifest, or `newer` when a later cezar wrote a version this one cannot read. */
async function loadManifest(gitDir: string): Promise<Loaded | 'newer'> {
  const loaded: Loaded = { extra: {}, skillsExtra: {}, entries: [], roots: [], legacy: false };
  const listed = new Set<string>();
  const add = (entry: ManifestEntry) => {
    if (listed.has(entry.path)) return;
    listed.add(entry.path);
    loaded.entries.push(entry);
  };
  const read = await readJson(join(gitDir, MANIFEST_FILE));
  if (read.found) {
    const version = (read.value as { version?: unknown } | null | undefined)?.version;
    if (typeof version === 'number' && version > MANIFEST_VERSION) return 'newer';
    // Unreadable: nothing is recorded as cezar's, and the next save replaces it.
    const parsed = manifestSchema.safeParse(read.value);
    if (parsed.success) {
      const { version: _version, entries, skills, ...extra } = parsed.data;
      const { roots, ...skillsExtra } = skills ?? {};
      Object.assign(loaded, { extra, skillsExtra, roots: strings(roots) });
      for (const raw of entries) {
        const entry = entrySchema.safeParse(raw);
        if (entry.success) add(entry.data);
      }
    }
  }
  const legacy = await readJson(join(gitDir, LEGACY_SKILLS_MANIFEST_FILE));
  const old = legacy.found ? legacySchema.safeParse(legacy.value) : undefined;
  if (old?.success) {
    // A `team-copy` entry's `marker:` identity is no content hash: `inspect` keeps that copy
    // and never acts on it, so it stays out of git and is never rewritten or removed.
    for (const raw of old.data.entries) {
      const entry = legacyEntrySchema.safeParse(raw);
      if (entry.success) add({ ...entry.data, writer: 'skills' });
    }
    loaded.roots = [...new Set([...loaded.roots, ...strings(old.data.roots)])];
    loaded.legacy = true;
  }
  return loaded;
}

/** How a tree's records are written into its hash, per identity prefix. */
interface TreeEncoding {
  link: (rel: string, target: string) => string;
  dir: (rel: string) => string;
  /** Written before the file's bytes; `fileEnd` after them. */
  file: (rel: string, size: number, executable: boolean) => string;
  fileEnd: string;
  special: (rel: string, mode: number) => string;
}

/**
 * Each name, link target and file is prefixed with its byte length, so no bytes pass for another
 * record. An executable file is an `X` record, so a `chmod +x` reads as a change.
 */
const sized = (value: string) => `${Buffer.byteLength(value)}:${value}`;
const TREE2: TreeEncoding = {
  link: (rel, target) => `L${sized(rel)}${sized(target)}`,
  dir: (rel) => `D${sized(rel)}`,
  file: (rel, size, executable) => `${executable ? 'X' : 'F'}${sized(rel)}${size}:`,
  fileEnd: '',
  special: (rel, mode) => `S${sized(rel)}${mode}:`,
};

/** The encoding a cezar before hearsay-tools/cezarion#1814 recorded; read only to check an imported identity. */
const LEGACY_TREE: TreeEncoding = {
  link: (rel, target) => `L ${rel} ${target}\n`,
  dir: (rel) => `D ${rel}\n`,
  file: (rel) => `F ${rel} `,
  fileEnd: '\n',
  special: (rel, mode) => `S ${rel} ${mode}\n`,
};

/** Only a regular file is opened: a FIFO, socket or device is hashed by its type, never read. */
async function digestInto(hash: Hash, path: string, rel: string, encoding: TreeEncoding): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) hash.update(encoding.link(rel, await readlink(path)));
  else if (stat.isDirectory()) {
    hash.update(encoding.dir(rel));
    for (const name of (await readdir(path)).sort()) await digestInto(hash, join(path, name), rel ? `${rel}/${name}` : name, encoding);
  } else if (stat.isFile()) {
    const bytes = await readFile(path);
    hash.update(encoding.file(rel, bytes.length, (stat.mode & 0o111) !== 0)).update(bytes).update(encoding.fileEnd);
  } else hash.update(encoding.special(rel, stat.mode));
}

async function digestOf(path: string, prefix: 'tree2' | 'tree'): Promise<string | null> {
  const stat = await lstat(path).catch(() => null);
  if (!stat) return null;
  if (stat.isSymbolicLink()) return `link:${await readlink(path)}`;
  const hash = createHash('sha256');
  await digestInto(hash, path, '', prefix === 'tree2' ? TREE2 : LEGACY_TREE);
  return `${prefix}:${hash.digest('hex')}`;
}

/** What is at `path` now, comparable with a recorded identity; null when nothing is there. */
export function identityOf(path: string): Promise<string | null> {
  return digestOf(path, 'tree2');
}

/** The identity `identityOf` reads from a regular file holding `content`. */
export function fileIdentity(content: string | Buffer, executable = false): string {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  return `tree2:${createHash('sha256').update(TREE2.file('', bytes.length, executable)).update(bytes).digest('hex')}`;
}

/** The identity a copy of the file at `source` reads as: its bytes and executable bit, through a link. */
export async function copyIdentity(source: string): Promise<string> {
  const [bytes, info] = await Promise.all([readFile(source), stat(source)]);
  return fileIdentity(bytes, (info.mode & 0o111) !== 0);
}

/** Only these identities can prove a path unchanged; any other (a legacy `marker:`) cannot. */
const verifiable = (identity: string) => /^(link|tree2?):/.test(identity);

async function removePath(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => null);
  if (!stat) return;
  if (stat.isDirectory()) await rm(path, { recursive: true, force: true });
  else await unlink(path);
}

async function isFile(path: string): Promise<boolean> {
  const stat = await lstat(path).catch(() => null);
  return stat?.isFile() === true;
}

/**
 * Rename into place; across filesystems (`EXDEV`), copy instead. A copy that fails is removed, so
 * the path is free and the next pass writes it again. A crash during the copy leaves a partial
 * entry that matches neither identity: it is kept, because nothing tells it from the agent's edit.
 */
async function moveInto(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    try {
      await cp(from, to, { recursive: true, verbatimSymlinks: true });
    } catch (copyError) {
      await rm(to, { recursive: true, force: true }).catch(() => undefined);
      throw copyError;
    }
    await rm(from, { recursive: true, force: true });
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function gitDirOf(worktree: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--absolute-git-dir'], { cwd: worktree, timeout: 10_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Thrown when the platform refuses a link, so a writer can fall back to a copy. */
export class LinkRefused extends Error {
  constructor(cause: unknown) {
    super('link refused', { cause });
  }
}

/**
 * What a write leaves at a path. `staged` is a path the caller built in `stagingDir()`; every
 * other kind is built here, so a writer imports no file-changing function of its own.
 */
export type EntryContent =
  | { type: 'link'; target: string; linkType?: 'dir' | 'file' | 'junction' }
  | { type: 'file'; text: string }
  | { type: 'file'; copyOf: string }
  | { type: 'dir'; files: ReadonlyArray<{ name: string; text: string } | { name: string; copyOf: string } | { name: string; linkTo: string }> }
  | { type: 'copy'; from: string }
  | { type: 'staged'; path: string };

export interface EntryMeta {
  kind: EntryKind;
  skill?: string;
  source?: string;
}

/** The steps of one write, in order. Tests stop a pass at one, as a crash would. */
export type WriteBoundary = 'staged' | 'pending' | 'cleared' | 'placed' | 'removed';

export interface WorktreeFilesOptions {
  /** Injected in tests to exercise the copy fallback. */
  symlink?: (target: string, path: string, type?: 'dir' | 'file' | 'junction') => Promise<void>;
  /** Tests only: runs at each boundary of a write; a throw ends the pass there. */
  faults?: (boundary: WriteBoundary, path: string) => void | Promise<void>;
}

/**
 * Who may write a path, for one writer. `ours`: listed, and still what cezar left. `free`:
 * nothing there. `theirs`: changed since, or never listed; the writer drops any entry and never
 * touches it. `kept`: never touched and never dropped (an interrupted write that no longer matches,
 * a kind or identity this cezar cannot check, another writer's path). `outside`: its parent dir
 * leads out of the worktree.
 */
export interface PathState {
  owner: 'ours' | 'free' | 'theirs' | 'kept' | 'outside';
  current: string | null;
  entry: ManifestEntry | undefined;
}

/**
 * One writer's view of a worktree's manifest for one pass. A write runs stage, pending, clear,
 * place, record: a crash leaves the old copy, nothing, or the new copy, each of which the next
 * pass reads as cezar's and repairs.
 */
export class WorktreeFiles {
  private readonly byPath: Map<string, ManifestEntry>;
  private readonly staged: string[] = [];
  private swept = false;
  private legacy: boolean;
  roots: string[];

  constructor(
    readonly worktree: string,
    private readonly root: string,
    private readonly gitDir: string,
    private readonly writer: ManifestWriter,
    private readonly loaded: Loaded,
    private readonly options: WorktreeFilesOptions,
  ) {
    this.byPath = new Map(loaded.entries.map((entry) => [entry.path, entry]));
    this.roots = loaded.roots;
    this.legacy = loaded.legacy;
  }

  /** This writer's entries. */
  entries(): ManifestEntry[] {
    return [...this.byPath.values()].filter((entry) => entry.writer === this.writer);
  }

  entry(path: string): ManifestEntry | undefined {
    const entry = this.byPath.get(path);
    return entry?.writer === this.writer ? entry : undefined;
  }

  async present(path: string): Promise<boolean> {
    return (await lstat(join(this.worktree, path)).catch(() => null)) !== null;
  }

  async inspect(path: string): Promise<PathState> {
    const at = join(this.worktree, path);
    // A redirected agent dir must not turn a write or a cleanup into one in another checkout.
    if (!(await landsInside(this.root, dirname(at)))) return { owner: 'outside', current: null, entry: this.entry(path) };
    const listed = this.byPath.get(path);
    const current = await identityOf(at);
    if (listed && (listed.writer !== this.writer || !KINDS.has(listed.kind))) return { owner: 'kept', current, entry: undefined };
    if (current === null) return { owner: 'free', current, entry: listed };
    if (!listed) return { owner: 'theirs', current, entry: undefined };
    if (current === listed.identity || current === listed.alternate) return { owner: 'ours', current, entry: listed };
    const legacy = await this.checkLegacy(at, listed, current);
    if (legacy === 'kept') return { owner: 'kept', current, entry: listed };
    if (legacy) return { owner: 'ours', current, entry: legacy };
    return { owner: listed.kind === 'pending' || !verifiable(listed.identity) ? 'kept' : 'theirs', current, entry: listed };
  }

  /**
   * An imported `tree:` identity, checked in its older encoding, which has no lengths: one tree can
   * read the same as another. A match proves the path unchanged only for a single file, or for a
   * dir holding only `SKILL.md` where cezar wrote just that. Then the entry is recorded again as
   * `current`. Any other match is kept: it may be cezar's copy or the agent's edit. Null when
   * nothing matched, so the path has changed.
   */
  private async checkLegacy(at: string, listed: ManifestEntry, current: string): Promise<ManifestEntry | 'kept' | null> {
    if (!listed.identity.startsWith('tree:') && !listed.alternate?.startsWith('tree:')) return null;
    const old = await digestOf(at, 'tree');
    const field = old === listed.identity ? 'identity' : old === listed.alternate ? 'alternate' : null;
    if (!field) return null;
    const stat = await lstat(at);
    if (!stat.isFile()) {
      // An older cezar wrote these as one `SKILL.md`; a copy of a whole source dir has no known shape.
      const oneSkillFile = listed.kind === 'generated' || (listed.kind === 'pending' && listed.identity.startsWith('tree:'));
      if (!oneSkillFile) return 'kept';
      if (!stat.isDirectory() || (await readdir(at)).join('/') !== 'SKILL.md') return null;
    }
    const entry = { ...listed, [field]: current };
    this.byPath.set(entry.path, entry);
    return entry;
  }

  /** A new dir in the private git dir to build an entry in; removed when the pass ends. */
  async stagingDir(): Promise<string> {
    const base = join(this.gitDir, STAGING_DIR);
    if (!this.swept) {
      this.swept = true;
      // Left by a pass a crash ended: removed once its process is gone.
      for (const name of await readdir(base).catch(() => [] as string[])) {
        const pid = Number.parseInt(name, 10);
        if (pid !== process.pid && !(pid > 0 && alive(pid))) await rm(join(base, name), { recursive: true, force: true });
      }
    }
    await mkdir(base, { recursive: true });
    const dir = join(base, `${process.pid}-${randomBytes(4).toString('hex')}`);
    await mkdir(dir);
    this.staged.push(dir);
    return dir;
  }

  /**
   * Write `content` at `path`, which must be free or cezar's. Returns the identity it left. The
   * pending entry is saved before the path changes; a file replaces a file in one rename. Returns
   * null when the agent wrote at the path while the entry was staged: the path stays the agent's,
   * with no entry.
   */
  async put(path: string, content: EntryContent, meta: EntryMeta): Promise<string | null> {
    const before = await this.inspect(path);
    if (before.owner !== 'free' && before.owner !== 'ours') throw new Error(`${path} is not cezar's to write`);
    const dest = join(this.worktree, path);
    let staged: string | undefined;
    let identity: string | null;
    if (content.type === 'link') identity = `link:${content.target}`;
    else {
      staged = await this.build(content);
      identity = await identityOf(staged);
    }
    if (identity === null) throw new Error(`nothing staged for ${path}`);
    await this.fault('staged', path);
    const alternate = before.current !== null && before.current !== identity ? before.current : undefined;
    this.byPath.set(path, this.newEntry(path, { ...meta, kind: 'pending' }, identity, alternate));
    await this.save();
    await this.fault('pending', path);
    // Read again just before the path changes: staging takes time, and the agent may write meanwhile.
    const now = await identityOf(dest);
    if (now !== null && now !== before.current) {
      this.byPath.delete(path);
      await this.save();
      return null;
    }
    if (now !== null && !(staged !== undefined && (await isFile(staged)) && (await isFile(dest)))) {
      await removePath(dest);
      await this.fault('cleared', path);
    }
    await mkdir(dirname(dest), { recursive: true });
    if (content.type === 'link') await this.link(content.target, dest, content.linkType);
    else await moveInto(staged!, dest);
    await this.fault('placed', path);
    this.byPath.set(path, this.newEntry(path, meta, identity));
    await this.save();
    return identity;
  }

  /** Record what is already at `path` as cezar's: an interrupted write that finished. */
  record(path: string, meta: EntryMeta, identity: string): void {
    this.byPath.set(path, this.newEntry(path, meta, identity));
  }

  /** Remove `path` while it is cezar's. The caller's next `save()` drops the entry. */
  async remove(path: string): Promise<boolean> {
    if ((await this.inspect(path)).owner !== 'ours') return false;
    await removePath(join(this.worktree, path));
    await this.fault('removed', path);
    this.byPath.delete(path);
    return true;
  }

  /** Drop this writer's entry for `path`; nothing at the path changes. */
  forget(path: string): void {
    if (this.entry(path)) this.byPath.delete(path);
  }

  /** Replace the manifest in one step: a crash leaves the old one or the new one, never half. */
  async save(): Promise<void> {
    const file = join(this.gitDir, MANIFEST_FILE);
    const entries = [...this.byPath.values()];
    const skills = this.roots.length > 0 || Object.keys(this.loaded.skillsExtra).length > 0
      ? { skills: { ...this.loaded.skillsExtra, roots: this.roots } }
      : {};
    if (entries.length === 0 && !skills.skills && Object.keys(this.loaded.extra).length === 0) await unlink(file).catch(() => undefined);
    else {
      const doc = { ...this.loaded.extra, version: MANIFEST_VERSION, entries, ...skills };
      const staging = `${file}.${process.pid}.tmp`;
      await writeFile(staging, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
      await rename(staging, file);
    }
    if (this.legacy) {
      await unlink(join(this.gitDir, LEGACY_SKILLS_MANIFEST_FILE)).catch(() => undefined);
      this.legacy = false;
    }
  }

  async close(): Promise<void> {
    for (const dir of this.staged) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  private newEntry(path: string, meta: Omit<EntryMeta, 'kind'> & { kind: string }, identity: string, alternate?: string): ManifestEntry {
    return {
      path,
      writer: this.writer,
      kind: meta.kind,
      ...(meta.skill !== undefined ? { skill: meta.skill } : {}),
      ...(meta.source !== undefined ? { source: meta.source } : {}),
      identity,
      ...(alternate !== undefined ? { alternate } : {}),
    };
  }

  private async fault(boundary: WriteBoundary, path: string): Promise<void> {
    await this.options.faults?.(boundary, path);
  }

  private async link(target: string, path: string, type?: 'dir' | 'file' | 'junction'): Promise<void> {
    const make = this.options.symlink ?? ((to: string, at: string, kind?: 'dir' | 'file' | 'junction') => symlink(to, at, kind));
    try {
      await make(target, path, type);
    } catch (error) {
      throw new LinkRefused(error);
    }
  }

  private async build(content: Exclude<EntryContent, { type: 'link' }>): Promise<string> {
    if (content.type === 'staged') {
      if (!resolve(content.path).startsWith(join(this.gitDir, STAGING_DIR) + sep)) throw new Error('staged outside the staging dir');
      return content.path;
    }
    const out = join(await this.stagingDir(), 'entry');
    if (content.type === 'file') {
      if ('text' in content) await writeFile(out, content.text, 'utf8');
      else await copyFile(content.copyOf, out);
    } else if (content.type === 'copy') {
      await cp(content.from, out, { recursive: true, dereference: true });
    } else {
      await mkdir(out);
      for (const file of content.files) {
        const at = join(out, file.name);
        if ('text' in file) await writeFile(at, file.text, 'utf8');
        else if ('copyOf' in file) await copyFile(file.copyOf, at);
        else await this.link(file.linkTo, at, 'file');
      }
    }
    return out;
  }
}

/**
 * One pass at a time per worktree, for every writer: each pass reads the manifest, changes
 * entries and saves it, so two overlapping passes (two live `/name` messages, or a seed and a
 * skills pass) would each save over the other's entries.
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

/**
 * Run `pass` with `writer`'s view of the worktree's manifest. `fallback` when the worktree has no
 * private git dir, or a newer cezar wrote a manifest version this one cannot read: then this cezar
 * writes nothing there and leaves the file alone.
 */
export function withWorktreeFiles<T>(
  worktree: string,
  writer: ManifestWriter,
  options: WorktreeFilesOptions,
  fallback: T,
  pass: (files: WorktreeFiles) => Promise<T>,
): Promise<T> {
  return serialized(worktree, async () => {
    const gitDir = await gitDirOf(worktree);
    const root = await realpath(worktree).catch(() => null);
    if (!gitDir || root === null) return fallback;
    const loaded = await loadManifest(gitDir);
    if (loaded === 'newer') return fallback;
    const files = new WorktreeFiles(worktree, root, gitDir, writer, loaded, options);
    try {
      return await pass(files);
    } finally {
      await files.close();
    }
  });
}
