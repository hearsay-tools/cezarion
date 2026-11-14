/** The owned-workspace record: receipt and cleanup checkpoint schemas, identity files and the intent check, on top of the Git layer. */
import { projectPaths } from '../project-paths.ts';
import { identityFileStore } from './identity-file-store.ts';
import { entryExists as exists } from './entry-exists.ts';
import { createHash } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { workerWorkspaceSchema } from '@open-mercato/cezar-contract/delegation';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { branchFor } from '../git-worktree.ts';
import { checkedGit, gitCommonDir } from './workspace-git.ts';

export const RECEIPT_CAP = 16_384;
// Identify owned branches by tip and reflog contents, not inode identity.
// Keep file/logFile fields for older strict checkpoint readers.
const fileIdentitySchema = z.object({ dev: z.number(), ino: z.number(), birthtimeMs: z.number() }).strict();
const branchIdentitySchema = z.object({ file: fileIdentitySchema, prefixBytes: z.number().int().min(1).max(4096), prefixHash: z.string().length(64) }).strict();
const receiptSchema = z.object({ workspace: workerWorkspaceSchema, gitDir: z.string().min(1), branchIdentity: branchIdentitySchema.optional() }).strict();
export const cleanupSchema = z.object({ workspace: workerWorkspaceSchema, gitDir: z.string(), sha: workerWorkspaceSchema.shape.baselineSha,
  logFile: fileIdentitySchema, logHash: z.string().length(64), phase: z.enum(['prepared', 'worktree-removed', 'complete']) }).strict();
export type Cleanup = z.infer<typeof cleanupSchema>;
export const hash = (content: Buffer) => createHash('sha256').update(content).digest('hex');
export async function replaceIdentityFile(path: string, content: string, assertCurrent?: () => void): Promise<void> {
  assertCurrent?.();
  await identityFileStore().replace(path, content, RECEIPT_CAP, assertCurrent);
}

export type Receipt = z.infer<typeof receiptSchema>;

export async function validateIntent(repoRoot: string, value: WorkerWorkspace): Promise<WorkerWorkspace> {
  const workspace = workerWorkspaceSchema.parse(value);
  const root = await realpath(repoRoot);
  if (!projectPaths(root).reads.some(directory => workspace.path === join(directory, 'worktrees', workspace.ownerRunId)) || workspace.branch !== branchFor(workspace.ownerRunId)) {
    throw new Error('Owned workspace identity does not match the managed resource');
  }
  // Do not let a symlinked managed-path prefix redirect creation into another tree.
  let prefix = dirname(workspace.path);
  while (prefix !== root) {
    if (await exists(prefix) && await realpath(prefix) !== prefix) throw new Error('Owned workspace path is redirected');
    prefix = dirname(prefix);
  }
  const sha = await checkedGit(root, ['rev-parse', '--verify', '--end-of-options', `${workspace.baselineSha}^{commit}`]);
  if (sha !== workspace.baselineSha) throw new Error('Owned baseline is not a pinned commit');
  return workspace;
}

export async function receiptLocation(repoRoot: string, workspace: WorkerWorkspace, create = false): Promise<string> {
  return join(await receiptDirectory(repoRoot, create), `${workspace.resourceId}.json`);
}
async function receiptDirectory(repoRoot: string, create: boolean): Promise<string> {
  const dir = join(await gitCommonDir(repoRoot), 'cezar-owned-workspaces');
  await identityFileStore().directory(dir, create);
  return dir;
}
/** The receipt and cleanup checkpoint files in the repository's shared receipt directory, checked
 *  as `receiptLocation` checks it; none when it does not exist. The project migration rewrites them. */
export async function ownedWorkspaceRecordFiles(repoRoot: string): Promise<string[]> {
  const dir = await receiptDirectory(repoRoot, false);
  if (!await exists(dir)) return [];
  return (await readdir(dir)).filter(name => name.endsWith('.json')).sort().map(name => join(dir, name));
}
/** Each readable receipt's workspace, and whether its cleanup checkpoint says the removal completed.
 *  An unreadable record is skipped: only an explicit destroy acts on it. */
export async function ownedWorkspaceReceipts(repoRoot: string): Promise<Array<{ workspace: WorkerWorkspace; cleaned: boolean }>> {
  const receipts: Array<{ workspace: WorkerWorkspace; cleaned: boolean }> = [];
  for (const path of await ownedWorkspaceRecordFiles(repoRoot)) {
    if (path.endsWith('.cleanup.json')) continue;
    try {
      const receipt = await readReceipt(path);
      if (!receipt) continue;
      const checkpoint = path.replace(/\.json$/, '.cleanup.json');
      const cleaned = await exists(checkpoint) &&
        cleanupSchema.parse(JSON.parse(await readIdentityFile(checkpoint, RECEIPT_CAP))).phase === 'complete';
      receipts.push({ workspace: receipt.workspace, cleaned });
    } catch { /* unreadable */ }
  }
  return receipts;
}
/** One receipt or cleanup checkpoint, read with the identity-file checks. */
export function readOwnedWorkspaceRecord(path: string): Promise<string> {
  return readIdentityFile(path, RECEIPT_CAP);
}
/** Replace one receipt or cleanup checkpoint atomically and privately, as cleanup checkpoints are. */
export function replaceOwnedWorkspaceRecord(path: string, content: string): Promise<void> {
  return replaceIdentityFile(path, content);
}
export function readIdentityFile(path: string, cap: number, privateParent = true): Promise<string> {
  return identityFileStore().read(path, cap, privateParent);
}
export function writeIdentityFile(path: string, content: string, privateParent = true): Promise<void> {
  return identityFileStore().write(path, content, privateParent);
}
export async function readReceipt(path: string): Promise<Receipt | undefined> {
  if (!await exists(path)) return undefined;
  return receiptSchema.parse(JSON.parse(await readIdentityFile(path, RECEIPT_CAP)));
}
