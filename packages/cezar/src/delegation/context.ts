import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { WorkerInput, WorkerInputRecipe, WorkerSpawnRequest, WorkerWorkspace } from '@open-mercato/cezar-contract';
import { resolveAttachmentPath } from '../workflows/attachment-path.ts';
import { DelegationPolicyError } from './policy.ts';

const git = promisify(execFile);
export const WORKER_CONTEXT_BYTES = 8 * 1024 * 1024;
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const invalid = () => new DelegationPolicyError('invalid_input', 'Worker context input is missing, redirected, changed, or exceeds its limit');

/** Fixed-size read, regular files only; neither a FIFO nor a growing file can evade the bound. */
export async function readBoundedContextFile(path: string, limit: number): Promise<Buffer> {
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
    return bytes.subarray(0, count);
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

/** Accept only pinned Git files and attachments in this parent's canonical owned directory. */
export async function prepareWorkerContext(options: {
  repoRoot: string; dataDir: string; parentId: string; workspace: WorkerWorkspace;
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
  try {
    for (const [index, source] of (context.artifacts ?? []).entries()) {
      if (source.kind === 'baseline-file') {
        const { stdout } = await git('git', ['ls-tree', '-z', workspace.baselineSha, '--', source.path], { cwd: repoRoot, maxBuffer: 16_384, timeout: 30_000 });
        const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t([^\0]+)\0$/.exec(stdout);
        if (!match || match[3] !== source.path) throw invalid();
        const size = await git('git', ['cat-file', '-s', match[2]!], { cwd: repoRoot, maxBuffer: 1024, timeout: 30_000 });
        inputs.push({ source, path: join(workspace.path, source.path), bytes: Number(size.stdout.trim()), sha256: hash(match[2]!) });
      } else {
        const bytes = await attachmentBytes(dataDir, parentId, source.id, WORKER_CONTEXT_BYTES - copied);
        if (options.containsSecret(bytes.toString('utf8'))) throw invalid();
        copied += bytes.length;
        const dir = await inputDirectory(dataDir, workspace.ownerRunId);
        if (!owned) {
          await mkdir(dir, { mode: 0o700 }); // exclusive: never adopt an unrelated existing store
          const stat = await lstat(dir); owned = { path: dir, dev: stat.dev, ino: stat.ino };
        }
        const path = join(dir, copyName(index));
        await writeCopy(path, bytes);
        inputs.push({ source, path, bytes: bytes.length, sha256: hash(bytes) });
      }
    }
    return { recipe: { ...(context.text === undefined ? {} : { text: context.text }), inputs }, discard };
  } catch {
    await discard();
    throw invalid();
  }
}

/** Restart/Continue trusts intact owned bytes; a missing copy can only be rebuilt from identical source bytes. */
export async function verifyWorkerContext(options: {
  dataDir: string; parentId: string; workspace: WorkerWorkspace; context?: WorkerInputRecipe;
}): Promise<void> {
  const { dataDir, parentId, workspace, context } = options;
  if (!context) return;
  let copied = 0;
  try {
    for (const [index, input] of context.inputs.entries()) {
      if (input.source.kind === 'baseline-file') {
        if (input.path !== join(workspace.path, input.source.path)) throw invalid();
        await canonicalFile(input.path);
        continue;
      }
      const path = join(await inputDirectory(dataDir, workspace.ownerRunId), copyName(index));
      if (input.path !== path) throw invalid();
      copied += input.bytes;
      if (copied > WORKER_CONTEXT_BYTES) throw invalid();
      let bytes: Buffer;
      try {
        await canonicalFile(path);
        bytes = await readBoundedContextFile(path, input.bytes);
      } catch (error) {
        // A redirected or modified copy is evidence of tampering, not permission to overwrite it.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        bytes = await attachmentBytes(dataDir, parentId, input.source.id, input.bytes);
        if (bytes.length !== input.bytes || hash(bytes) !== input.sha256) throw invalid();
        await writeCopy(path, bytes);
      }
      if (bytes.length !== input.bytes || hash(bytes) !== input.sha256) throw invalid();
    }
  } catch { throw invalid(); }
}

export function workerContextTask(task: string, recipe: WorkerInputRecipe): string {
  return task + (recipe.text === undefined ? '' : `\n\nSelected context:\n${recipe.text}`) +
    (recipe.inputs.length ? `\n\nSelected input files (worker-local paths):\n${recipe.inputs.map(input => JSON.stringify(input.path)).join('\n')}` : '');
}
