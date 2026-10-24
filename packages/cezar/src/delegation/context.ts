import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { parentFileRefusal, type WorkerInput, type WorkerInputRecipe, type WorkerSpawnRequest, type WorkerWorkspace } from '@open-mercato/cezar-contract/delegation';
import { resolveAttachmentPath } from '../workflows/attachment-path.ts';
import { DelegationPolicyError } from './policy.ts';

const git = promisify(execFile);
export const WORKER_CONTEXT_BYTES = 8 * 1024 * 1024;
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const invalid = () => new DelegationPolicyError('invalid_input', 'Worker context input is missing, redirected, changed, or exceeds its limit');

/** Fixed-size read, regular files only; neither a FIFO nor a growing file can evade the bound. */
export async function readBoundedContextFile(path: string, limit: number): Promise<Buffer> {
  return (await readBoundedFile(path, limit)).bytes;
}
/** The same read, with the opened file's own stat: O_NOFOLLOW guards only the last component,
 * so a caller binds the bytes to a path by comparing this identity with the path's. */
async function readBoundedFile(path: string, limit: number): Promise<{ bytes: Buffer; stat: Stats }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > limit) throw invalid();
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const next = await file.read(bytes, count, bytes.length - count, count);
      if (!next.bytesRead) break;
      count += next.bytesRead;
    }
    const after = await file.stat();
    if (count > limit || count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw invalid();
    return { bytes: bytes.subarray(0, count), stat: after };
  } finally { await file.close(); }
}

async function canonicalFile(path: string): Promise<void> {
  if (await realpath(path) !== path || !(await lstat(path)).isFile()) throw invalid();
}
async function inputDirectory(dataDir: string, workerId: string): Promise<string> {
  const root = await realpath(dataDir);
  const runs = join(root, 'runs');
  if (await realpath(runs) !== runs) throw invalid();
  return join(runs, `${workerId}-images`);
}
function copyName(index: number) { return `worker-context-${index}.input`; }
/** Where a `parent-file` input's owned snapshot lives; its recipe `path` names the worker worktree copy instead. */
export async function parentFileSnapshotPath(dataDir: string, workspace: WorkerWorkspace, index: number): Promise<string> {
  return join(await inputDirectory(dataDir, workspace.ownerRunId), copyName(index));
}
async function writeCopy(path: string, bytes: Buffer): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (await realpath(dir) !== dir) throw invalid();
  const temporary = join(dir, `.context-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  try {
    if (await realpath(dir) !== dir) throw invalid();
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
async function attachmentBytes(dataDir: string, parentId: string, id: string, limit: number) {
  const source = resolveAttachmentPath(dataDir, parentId, id);
  const expected = join(await realpath(dataDir), 'runs', `${parentId}-images`, id);
  if (!source || source !== expected) throw invalid();
  await canonicalFile(source);
  const bytes = await readBoundedContextFile(source, limit);
  await canonicalFile(source);
  return bytes;
}

const refuse = (message: string) => new DelegationPolicyError('invalid_input', message);
/**
 * Read a regular parent-worktree file without symlink components. Revalidate the open
 * descriptor’s identity and containment before accepting bytes; path checks alone are
 * insufficient.
 */
async function parentFile(parentCwd: string, path: string): Promise<{ read(limit: number): Promise<Buffer> }> {
  const source = join(await realpath(parentCwd), path);
  const notFound = (error: NodeJS.ErrnoException) => error.code === 'ENOENT' || error.code === 'ENOTDIR';
  const canonical = async () => {
    const [real, entry] = await Promise.all([realpath(source), lstat(source)]).catch((error: NodeJS.ErrnoException) => {
      throw notFound(error) ? refuse(`--attach path not found: ${path}`) : refuse(`--attach path is not a regular file inside the parent worktree: ${path}`);
    });
    if (real !== source || !entry.isFile()) throw refuse(`--attach path is not a regular file inside the parent worktree: ${path}`);
    return entry;
  };
  const checked = await canonical();
  return { async read(limit) {
    if (checked.size > limit) throw invalid();
    // It was a regular file at the canonical path a moment ago: any read failure is a change.
    const read = await readBoundedFile(source, limit).catch((error: NodeJS.ErrnoException) => {
      throw notFound(error) ? refuse(`--attach path not found: ${path}`) : refuse(`--attach path changed while it was read: ${path}`);
    });
    const entry = await canonical();
    if (entry.dev !== read.stat.dev || entry.ino !== read.stat.ino) throw refuse(`--attach path changed while it was read: ${path}`);
    return read.bytes;
  } };
}
async function ignoredByGit(cwd: string, path: string): Promise<boolean> {
  return git('git', ['check-ignore', '-q', '--', path], { cwd, maxBuffer: 16_384, timeout: 30_000 }).then(() => true, (error: { code?: unknown }) => {
    if (error.code === 1) return false;
    throw error;
  });
}

/** Accept only pinned Git files, attachments in this parent's canonical owned directory, and ignored parent-worktree files. */
export async function prepareWorkerContext(options: {
  repoRoot: string; dataDir: string; parentId: string; workspace: WorkerWorkspace;
  /** The parent's working directory: the worktree `parent-file` references are relative to. */
  parentCwd: string;
  context: NonNullable<WorkerSpawnRequest['context']>;
  containsSecret(text: string): boolean;
}): Promise<{ recipe: WorkerInputRecipe; discard(): Promise<void> }> {
  const { repoRoot, dataDir, parentId, workspace, context } = options;
  const inputs: WorkerInput[] = [];
  let copied = 0;
  let owned: { path: string; dev: number; ino: number } | undefined;
  const discard = async () => {
    if (!owned) return;
    const current = await lstat(owned.path).catch(() => undefined);
    if (current?.dev === owned.dev && current.ino === owned.ino && await realpath(owned.path) === owned.path) {
      await rm(owned.path, { recursive: true });
    }
  };
  const snapshot = async (index: number, bytes: Buffer) => {
    if (options.containsSecret(bytes.toString('utf8'))) throw invalid();
    copied += bytes.length;
    const dir = await inputDirectory(dataDir, workspace.ownerRunId);
    if (!owned) {
      await mkdir(dir, { mode: 0o700 }); // exclusive: never adopt an unrelated existing store
      const stat = await lstat(dir); owned = { path: dir, dev: stat.dev, ino: stat.ino };
    }
    const path = join(dir, copyName(index));
    await writeCopy(path, bytes);
    return { path, bytes: bytes.length, sha256: hash(bytes) };
  };
  try {
    for (const [index, source] of (context.artifacts ?? []).entries()) {
      if (source.kind === 'baseline-file') {
        const { stdout } = await git('git', ['ls-tree', '-z', workspace.baselineSha, '--', source.path], { cwd: repoRoot, maxBuffer: 16_384, timeout: 30_000 });
        const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t([^\0]+)\0$/.exec(stdout);
        if (!match || match[3] !== source.path) throw invalid();
        const size = await git('git', ['cat-file', '-s', match[2]!], { cwd: repoRoot, maxBuffer: 1024, timeout: 30_000 });
        inputs.push({ source, path: join(workspace.path, source.path), bytes: Number(size.stdout.trim()), sha256: hash(match[2]!) });
      } else if (source.kind === 'parent-file') {
        // Only an ignored file may enter the worker worktree: anything else would come back
        // through its diff and autosave commits. Confinement is checked before `check-ignore`,
        // which dies outright on a path beyond a symlink.
        const refusal = parentFileRefusal(source.path);
        if (refusal) throw refuse(refusal);
        const { stdout } = await git('git', ['ls-tree', '-z', workspace.baselineSha, '--', source.path], { cwd: repoRoot, maxBuffer: 16_384, timeout: 30_000 });
        if (stdout) throw refuse(`--attach path is tracked by git: ${source.path}; commit your changes and spawn from that commit instead of attaching it`);
        const file = await parentFile(options.parentCwd, source.path);
        if (!await ignoredByGit(options.parentCwd, source.path)) throw refuse(`--attach path is not ignored by git: ${source.path}; commit it and spawn from that commit instead of attaching it`);
        const copy = await snapshot(index, await file.read(WORKER_CONTEXT_BYTES - copied));
        inputs.push({ source, path: join(workspace.path, source.path), bytes: copy.bytes, sha256: copy.sha256 });
      } else {
        const bytes = await attachmentBytes(dataDir, parentId, source.id, WORKER_CONTEXT_BYTES - copied);
        inputs.push({ source, ...await snapshot(index, bytes) });
      }
    }
    return { recipe: { ...(context.text === undefined ? {} : { text: context.text }), inputs }, discard };
  } catch (error) {
    await discard();
    // A named `--attach` refusal tells the parent which path to fix; everything else stays generic.
    throw error instanceof DelegationPolicyError ? error : invalid();
  }
}

/** Restart/Continue trusts intact owned bytes; a missing copy can only be rebuilt from identical source bytes. */
export async function verifyWorkerContext(options: {
  dataDir: string; parentId: string; workspace: WorkerWorkspace; context?: WorkerInputRecipe;
  /** The parent's worktree, the only source a missing `parent-file` snapshot may be rebuilt from. */
  parentCwd?: string;
}): Promise<void> {
  const { dataDir, parentId, workspace, context, parentCwd } = options;
  if (!context) return;
  let copied = 0;
  try {
    for (const [index, input] of context.inputs.entries()) {
      if (input.source.kind === 'baseline-file') {
        if (input.path !== join(workspace.path, input.source.path)) throw invalid();
        await canonicalFile(input.path);
        continue;
      }
      const { source } = input;
      // A parent-file recipe names the worker worktree copy, which the worker may edit or delete:
      // only the owned snapshot is verified.
      const path = await parentFileSnapshotPath(dataDir, workspace, index);
      if (input.path !== (source.kind === 'parent-file' ? join(workspace.path, source.path) : path)) throw invalid();
      copied += input.bytes;
      if (copied > WORKER_CONTEXT_BYTES) throw invalid();
      let bytes: Buffer;
      try {
        await canonicalFile(path);
        bytes = await readBoundedContextFile(path, input.bytes);
      } catch (error) {
        // A redirected or modified copy is evidence of tampering, not permission to overwrite it.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // realpath also reports ENOENT for a dangling symlink; only a missing entry permits rebuilding.
        const entry = await lstat(path).catch((failure: NodeJS.ErrnoException) => {
          if (failure.code !== 'ENOENT') throw failure;
          return undefined;
        });
        if (entry) throw invalid();
        if (source.kind === 'parent-file') {
          if (parentCwd === undefined) throw invalid();
          bytes = await (await parentFile(parentCwd, source.path)).read(input.bytes);
        } else bytes = await attachmentBytes(dataDir, parentId, source.id, input.bytes);
        if (bytes.length !== input.bytes || hash(bytes) !== input.sha256) throw invalid();
        await writeCopy(path, bytes);
      }
      if (bytes.length !== input.bytes || hash(bytes) !== input.sha256) throw invalid();
    }
  } catch (error) {
    // As at spawn: a named `--attach` refusal tells the parent which path to repair.
    throw error instanceof DelegationPolicyError ? error : invalid();
  }
}

/**
 * Copy verified parent-file snapshots before first launch only. Never overwrite existing worker
 * content or restore deleted files on Continue. Require baseline ignore rules and recheck the
 * whole batch; remove this call’s copies on failure.
 */
export async function placeWorkerAttachments(options: { dataDir: string; workspace: WorkerWorkspace; context?: WorkerInputRecipe }): Promise<void> {
  const { dataDir, workspace, context } = options;
  const root = await realpath(workspace.path);
  const notIgnored = (path: string) => refuse(`--attach path is not ignored by the worker baseline: ${path}; commit it and spawn from that commit instead of attaching it`);
  const detail = (error: unknown) => error instanceof Error ? error.message : String(error);
  const attached: string[] = [];
  const created: Array<{ source: string; dir: string; path: string; dev: number; ino: number }> = [];
  try {
    for (const [index, input] of (context?.inputs ?? []).entries()) {
      const { source } = input;
      if (source.kind !== 'parent-file') continue;
      attached.push(source.path);
      try {
        const components = source.path.split('/');
        const name = components.pop()!;
        // Existing components first: `check-ignore` dies outright on a path beyond a symlink.
        const walk = async (create: boolean) => {
          let dir = root;
          for (const component of components) {
            dir = join(dir, component);
            const entry = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error;
              return undefined;
            });
            if (!entry && !create) return;
            if (!entry) await mkdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
            const current = entry ?? await lstat(dir);
            if (current.isSymbolicLink() || !current.isDirectory()) {
              throw refuse(`--attach path has a component that is not a directory in the worker worktree: ${source.path}`);
            }
          }
          return dir;
        };
        await walk(false);
        if (!await ignoredByGit(root, source.path)) throw notIgnored(source.path);
        const bytes = await (async () => readBoundedContextFile(await parentFileSnapshotPath(dataDir, workspace, index), input.bytes))()
          .catch((error: unknown) => { throw refuse(`--attach snapshot is missing or changed: ${source.path} (${detail(error)})`); });
        if (bytes.length !== input.bytes || hash(bytes) !== input.sha256) throw refuse(`--attach snapshot is missing or changed: ${source.path}`);
        const dir = (await walk(true))!;
        const destination = join(dir, name);
        let file;
        try {
          file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw error;
        }
        try {
          const opened = await file.stat();
          const entry = await lstat(destination).catch(() => undefined);
          // A directory swapped for a symlink since the walk: the file is elsewhere, and unlinking
          // through the redirected path could remove someone else's. Leave it, write nothing.
          if (await realpath(dir).catch(() => undefined) !== dir || entry?.dev !== opened.dev || entry.ino !== opened.ino) {
            throw refuse(`--attach path leaves the worker worktree: ${source.path}`);
          }
          created.push({ source: source.path, dir, path: destination, dev: opened.dev, ino: opened.ino });
          await file.writeFile(bytes);
        } finally { await file.close(); }
      } catch (error) {
        throw error instanceof DelegationPolicyError ? error : refuse(`--attach path could not be placed in the worker worktree: ${source.path} (${detail(error)})`);
      }
    }
    // A placed file can change the rules for another (a nested `.gitignore` re-including it).
    if (attached.length) {
      const check = git('git', ['check-ignore', '-z', '--stdin'], { cwd: root, maxBuffer: 1024 * 1024, timeout: 30_000 });
      // A git that exits early fails the promise below; its EPIPE on stdin must not crash the process.
      check.child.stdin?.on('error', () => {}).end(attached.map(path => `${path}\0`).join(''));
      const result = await check
        .then(({ stdout }) => stdout, (error: { code?: unknown; message?: string }) => {
          if (error.code === 1) return '';
          throw refuse(`--attach paths could not be checked against the worker baseline: ${attached[0]} (${detail(error)})`);
        });
      const ignored = new Set(result.split('\0'));
      const offending = attached.find(path => !ignored.has(path));
      if (offending !== undefined) throw notIgnored(offending);
    }
  } catch (error) {
    // Only files this call created, still the same inode in the same canonical directory. Each
    // removal is attempted on its own; one that fails is reported, never allowed to hide the cause.
    const leftovers: string[] = [];
    for (const copy of created.reverse()) {
      try {
        const entry = await lstat(copy.path).catch(() => undefined);
        if (entry?.dev === copy.dev && entry.ino === copy.ino && await realpath(copy.dir).catch(() => undefined) === copy.dir) {
          await rm(copy.path, { force: true });
        }
      } catch (failure) { leftovers.push(`${copy.source} (${detail(failure)})`); }
    }
    if (!leftovers.length) throw error;
    throw refuse(`${detail(error)}; could not remove the attached copies made before the failure: ${leftovers.join(', ')}`);
  }
}

export function workerContextTask(task: string, recipe: WorkerInputRecipe): string {
  return task + (recipe.text === undefined ? '' : `\n\nSelected context:\n${recipe.text}`) +
    (recipe.inputs.length ? `\n\nSelected input files (worker-local paths):\n${recipe.inputs.map(input => JSON.stringify(input.path)).join('\n')}` : '');
}
