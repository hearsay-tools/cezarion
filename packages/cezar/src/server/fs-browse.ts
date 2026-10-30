import type { Dirent } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { expandTilde } from '../paths.ts';

/**
 * Directory browsing confined to the browse root. Check lexical containment before I/O, then
 * realpath containment for the requested path and every returned entry. Never disclose escaping
 * targets.
 */

/** One listed subdirectory. `path` is absolute — this route is same-origin and
 *  behind the cockpit, exactly like `GET /api/projects`' `root`s (health, the
 *  CORS-open route, is the one that must never carry absolute paths). */
export interface FsBrowseDir {
  name: string;
  path: string;
  /** Has a `.git` entry — file or dir, so linked worktrees count. Drives the
   *  "repo" badge in the picker; a non-repo folder is still selectable. */
  isRepo: boolean;
}

/** `GET /api/fs/browse?path=` — the spec's shape plus `truncated`. */
export interface FsBrowseResponse {
  /** The realpath'd directory actually listed (never the spelling asked for —
   *  the picker's breadcrumb should show where it really is). */
  path: string;
  /** `null` AT the browse root: there is no "up" out of the root, and the UI
   *  needs that to be a shape it cannot mis-navigate. */
  parent: string | null;
  dirs: FsBrowseDir[];
  /** True when `dirs` was capped — an honest signal beats a silently short
   *  list in a directory with tens of thousands of children. */
  truncated: boolean;
}

export type BrowseResult =
  | { ok: true; body: FsBrowseResponse }
  | { ok: false; status: 400 | 403 | 404; error: string };

/**
 * Entry cap. A picker cannot usefully render more, and an unbounded listing
 * turns one request into a per-entry `stat` storm (`isRepo` + symlink
 * resolution) on e.g. a node_modules parent.
 */
const MAX_ENTRIES = 1000;

/**
 * Home folders macOS guards with a privacy prompt (Files & Folders, Media & Apple Music,
 * Photos, Full Disk Access). Opening the picker at `~` must not LOOK INSIDE them: the `.git`
 * probe below is a read inside the folder, and in the desktop app it made macOS ask "Cezar
 * would like to access Apple Music…" (and Documents, Desktop, Downloads…) before the user
 * clicked anything. They are still listed; opening one is the user's choice, and so is the
 * prompt that follows. Their `isRepo` is simply `false`.
 */
const PRIVACY_PROTECTED_HOME_DIRS = new Set(['Desktop', 'Documents', 'Downloads', 'Library', 'Movies', 'Music', 'Pictures']);

/** The 403 a macOS privacy denial answers with; the picker offers System Settings beside it. */
export const MACOS_PRIVACY_BLOCKED = 'macOS privacy settings do not allow cezar to read this folder.';

/**
 * Expand the configured browse root. The workspace owns this independently
 * from the checkout root, so browsing never follows a clone-destination edit.
 */
export function resolveBrowseRoot(browseRoot: string): string {
  return expandTilde(browseRoot);
}

/** `candidate` is `root` or strictly beneath it. Both must already be
 *  realpath'd for this to mean anything. The explicit separator suffix is what
 *  stops `/home/bob-evil` from passing as inside `/home/bob`; the `endsWith`
 *  guard keeps a root of `/` from becoming the prefix `//`. */
function contains(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Is `candidate` the browse root or strictly beneath it — the same containment
 * question `browseDirectory` asks, exported for the ONE other route that must
 * ask it: `POST /api/projects` (step 4.2).
 *
 * Configuring the browse root only limits what the picker
 * can SEE. A register call naming an arbitrary absolute path would walk around
 * that in one request — and a registered project's panes read its whole tree.
 * So the register route re-asks containment for itself, against the same root,
 * with the same realpath-based rule. Both paths are realpath'd here (unlike
 * `contains`, which trusts its callers) because neither is guaranteed resolved.
 */
/**
 * The LEXICAL half of the containment question: does `candidate` spell as being inside `root`,
 * judged without asking whether it exists?
 *
 * `isInsideBrowseRoot` below realpaths both sides, which makes it answer `false` for a path that
 * is inside the root but simply not there — so using it alone as the first gate would tell a
 * hosted user who typo'd a folder under their own checkout root that it is "outside the browsable
 * root". This split lets the register route reject out-of-root paths UNIFORMLY (the existence
 * oracle stays shut, because a spelling outside the root is refused whether or not it exists),
 * then answer honestly about existence, then still catch symlink escapes with the realpath gate.
 */
export async function isLexicallyInsideBrowseRoot(root: string, candidate: string): Promise<boolean> {
  const realRoot = await realpathOrNull(root);
  if (realRoot === null) return false;
  return contains(realRoot, resolve(candidate));
}

export async function isInsideBrowseRoot(root: string, candidate: string): Promise<boolean> {
  const realRoot = await realpathOrNull(root);
  if (realRoot === null) return false;
  const real = await realpathOrNull(candidate);
  if (real === null) return false;
  return contains(realRoot, real);
}

/** realpath or null — every "does it exist / where does it really point"
 *  question in this module is best-effort and answered without throwing. */
async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * List the directories inside `path`, contained within `root`.
 *
 * `path` is the raw query value: absent/empty means the root itself, `~`
 * spellings are expanded, and a relative value resolves against the root (so
 * the route is usable without the caller knowing the absolute root, and a
 * relative `../..` is still caught by the same containment check as everything
 * else).
 */
export async function browseDirectory(opts: {
  root: string;
  path?: string | undefined;
  showHidden?: boolean;
}): Promise<BrowseResult> {
  // The root is realpath'd ONCE, up front: it is the yardstick every later
  // comparison uses, and comparing a resolved candidate against an
  // unresolved root would reject legitimate paths on any machine whose home
  // sits behind a symlink (macOS `/tmp`, NFS automounts, `/home` → `/usr/home`).
  const root = await realpathOrNull(opts.root);
  // A configured browse root that does not exist yet lands here. There
  // is nothing to browse and nothing informative to say about a path the
  // caller cannot see anyway.
  if (root === null) return { ok: false, status: 404, error: 'browse root is not available' };

  const requested = (opts.path ?? '').trim();
  // A NUL byte would make the fs calls throw `ERR_INVALID_ARG_VALUE` instead of
  // failing containment; reject it as malformed input before it gets that far.
  if (requested.includes('\0')) return { ok: false, status: 400, error: 'invalid path' };

  const expanded = requested === '' ? root : expandTilde(requested);
  // `resolve` handles both spellings: an absolute value stands alone, a
  // relative one is taken from the root. Either way `..` is folded away here,
  // so the lexical check below sees the real intent.
  const target = isAbsolute(expanded) ? resolve(expanded) : resolve(root, expanded);
  // Lexical gate: `..` traversal and absolute escapes die here, before any
  // syscall — so an escape attempt cannot even be used to probe which paths
  // outside the root exist (the timing/`404`-vs-`400` difference would tell).
  if (!contains(root, target)) return { ok: false, status: 400, error: 'path is outside the browsable root' };

  const real = await realpathOrNull(target);
  if (real === null) return { ok: false, status: 404, error: 'no such directory' };
  // Authoritative gate: `target` spelled as inside the root, but the symlink
  // chain may land anywhere. This is the check that catches a symlink planted
  // inside home pointing at `/etc` (or, in hosted mode, at the rest of the
  // host's disk).
  if (!contains(root, real)) return { ok: false, status: 400, error: 'path is outside the browsable root' };

  const info = await stat(real).catch(() => null);
  // Not a directory ⇒ same answer as "not there". The picker only navigates
  // directories, and distinguishing "this is a file" would confirm the
  // existence of a file the caller was never shown.
  if (!info?.isDirectory()) return { ok: false, status: 404, error: 'no such directory' };

  const entries = await readEntries(real);
  if (!Array.isArray(entries)) return entries;

  const showHidden = opts.showHidden === true;
  const candidates = entries
    .filter((entry) => showHidden || !entry.name.startsWith('.'))
    // Symlinks are resolved below (a symlinked project dir is a normal setup);
    // everything that is neither a directory nor a symlink is not our business.
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .sort((a, b) => a.name.localeCompare(b.name));
  const truncated = candidates.length > MAX_ENTRIES;
  const inHome = real === (await realpathOrNull(expandTilde('~')));

  const dirs = await listDirs(root, real, candidates.slice(0, MAX_ENTRIES), inHome);

  return {
    ok: true,
    body: {
      path: real,
      // Never above the root, even when the real parent exists — `dirname('/')`
      // is `/`, and the root's parent is simply not part of this surface.
      parent: real === root ? null : dirname(real),
      dirs,
      truncated,
    },
  };
}

/** The entries of `real`, or the failure to answer when it cannot be read. */
async function readEntries(real: string): Promise<Dirent[] | Extract<BrowseResult, { ok: false }>> {
  let readError: NodeJS.ErrnoException | null = null;
  const entries = await readdir(real, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    readError = error;
    return null;
  });
  if (entries === null) {
    // macOS privacy (TCC) refuses with EPERM — a folder the parent listing already showed, that
    // the user can unblock in System Settings. Saying "no such directory" there left them stuck.
    if (process.platform === 'darwin' && (readError as NodeJS.ErrnoException | null)?.code === 'EPERM') {
      return { ok: false, status: 403, error: MACOS_PRIVACY_BLOCKED };
    }
    // Unreadable otherwise (mode 0300, permission-denied mount) — indistinguishable from
    // absent, on purpose.
    return { ok: false, status: 404, error: 'no such directory' };
  }

  return entries;
}

/** The listed directories among `entries`, each with whether it is a git repository. */
async function listDirs(root: string, real: string, entries: Dirent[], inHome: boolean): Promise<FsBrowseDir[]> {
  const dirs: FsBrowseDir[] = [];
  for (const entry of entries) {
    const childPath = join(real, entry.name);
    if (entry.isSymbolicLink()) {
      const childReal = await realpathOrNull(childPath);
      // A symlink is listed only when it resolves to a directory that is
      // ITSELF inside the root. Listing an escaping link and rejecting it on
      // click would leak the same fact one step later — that a path outside
      // the root exists.
      if (childReal === null || !contains(root, childReal)) continue;
      const childInfo = await stat(childReal).catch(() => null);
      if (!childInfo?.isDirectory()) continue;
    }
    dirs.push({
      name: entry.name,
      // The link's own path, not its target: the breadcrumb should read the
      // way the operator's filesystem reads, and navigating into it re-runs
      // the containment check from scratch.
      path: childPath,
      isRepo: inHome && PRIVACY_PROTECTED_HOME_DIRS.has(entry.name) ? false : await exists(join(childPath, '.git')),
    });
  }

  return dirs;
}
