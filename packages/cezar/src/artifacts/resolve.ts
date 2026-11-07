import { imageMimeType, isOsOpenableImage } from '@open-mercato/cezar-contract/image-path';
import { constants } from 'node:fs';
import { open, realpath, lstat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileLinkResult, FilePreviewData, PublishedArtifact } from '@open-mercato/cezar-contract';
import { FILE_CONTENT_CAP } from '../server/git-changes.ts';
import { artifactDirectory, listArtifacts, readArtifact } from './store.ts';

const IMAGE_CAP = 10 * 1024 * 1024;
const contained = (root: string, path: string) => path === root || path.startsWith(root + sep);
function privatePath(root: string, target: string): boolean {
  const segments = relative(root, target).split(sep);
  return segments.includes('.git') || segments.some((part, i) => part === '.ai' && segments[i + 1] === 'cezar');
}
export function rasterMime(path: string): string | null { return isOsOpenableImage(path) ? imageMimeType(path) : null; }

export function artifactPreview(artifact: PublishedArtifact, bytes: Buffer): FilePreviewData {
  const binary = bytes.subarray(0, 8192).includes(0);
  const tooLarge = bytes.length > FILE_CONTENT_CAP;
  return { type: 'file', source: 'artifact', artifact, path: artifact.name, size: bytes.length, binary, tooLarge,
    ...(!binary && !tooLarge ? { content: bytes.toString('utf8') } : {}) };
}

type Context = { dataDir: string; runId: string; workingDirectory?: string; projectRoot: string; path: string };
type Loaded = { preview: FileLinkResult; imageBytes?: Buffer };
type PathCheck = { path: string } | { reason: string };

/** Turns the requested path into a local path string: `file:` URLs are decoded, other schemes are refused. */
function resolveRequestedPath(raw: string): PathCheck {
  try {
    if (!raw || raw.length > 8192 || /[\u0000-\u001f]/.test(raw)) return { reason: 'Invalid file path.' };
    let path: string;
    if (/^file:/i.test(raw)) path = fileURLToPath(new URL(raw));
    else {
      if (/^[a-z][a-z\d+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) return { reason: 'Not a local file path.' };
      // Query decoding has already happened. This is a literal filesystem path;
      // decoding it again would turn a filename containing %20 into a space.
      path = raw;
    }
    if (/[\u0000-\u001f]/.test(path) || path.startsWith('//') || path.startsWith('\\\\')) return { reason: 'Network file paths are not supported.' };
    if (process.platform !== 'win32' && /^[a-z]:[\\/]/i.test(path)) return { reason: 'This path belongs to a different operating system.' };
    return { path };
  } catch { return { reason: 'Invalid local file URL or encoding.' }; }
}

/** The allowed root the target must live in: the worktree first, then the project root. */
function allowedRoot(target: string, workingDirectory: string | undefined, projectRoot: string): string | undefined {
  const working = workingDirectory ? resolve(workingDirectory) : undefined;
  const project = resolve(projectRoot);
  return working && contained(working, target) ? working : contained(project, target) ? project : undefined;
}

/** Outside any allowed root, a published artifact snapshot whose source path matches still answers. */
async function publishedArtifact(ctx: Context, target: string): Promise<Loaded> {
  const directory = artifactDirectory(ctx.dataDir, ctx.runId);
  const matches = (await listArtifacts(directory, ctx.runId)).filter(item => item.sourcePath === target)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const entry = matches[0] ? await readArtifact(directory, ctx.runId, matches[0].id) : null;
  if (entry) return { preview: artifactPreview(entry.metadata, entry.bytes), ...(rasterMime(entry.metadata.name) ? { imageBytes: entry.bytes } : {}) };
  return { preview: { type: 'unpublished', path: ctx.path, reason: 'This file is outside the project. Ask the agent to publish it with cez artifact publish <path> and share the returned link.' } };
}

/** Reads at most one byte past `cap`, so an oversized file is detected without reading it whole. */
async function readCapped(handle: FileHandle, size: number, cap: number): Promise<Buffer> {
  const bytes = Buffer.alloc(Math.min(size, cap) + 1);
  let length = 0;
  while (length < bytes.length) {
    const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
    if (!bytesRead) break;
    length += bytesRead;
  }
  return bytes.subarray(0, length);
}

/** Verifies the target is a readable regular file inside `root`, then reads it under its kind's cap. */
async function readLinkedFile(ctx: Context, root: string, target: string, working: string | undefined): Promise<Loaded> {
  const unavailable = (reason: string): Loaded => ({ preview: { type: 'unavailable', path: ctx.path, reason } });
  const info = await lstat(target);
  if (info.isDirectory()) return unavailable('Choose a file inside this directory.');
  if (!info.isFile() || info.isSymbolicLink()) return unavailable('Only regular files can be previewed; symlinks are not served.');
  const [realRoot, actual] = await Promise.all([realpath(root), realpath(target)]);
  if (!contained(realRoot, actual) || privatePath(realRoot, actual)) return unavailable('The file resolves outside the permitted directory or into private state.');
  const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return unavailable('Not a regular file.');
    const raster = rasterMime(target);
    const cap = raster ? IMAGE_CAP : FILE_CONTENT_CAP;
    const sample = await readCapped(handle, stat.size, cap);
    const binary = sample.subarray(0, 8192).includes(0);
    const tooLarge = stat.size > FILE_CONTENT_CAP || sample.length > FILE_CONTENT_CAP;
    const preview: FilePreviewData = { type: 'file', source: root === working ? 'worktree' : 'project', path: target, size: stat.size, binary, tooLarge,
      ...(!binary && !tooLarge ? { content: sample.toString('utf8') } : {}) };
    return { preview, ...(raster && stat.size <= IMAGE_CAP && sample.length <= IMAGE_CAP ? { imageBytes: sample } : {}) };
  } finally { await handle.close(); }
}

/** No outside source is opened or even stat'ed: it can only match a published snapshot. */
export async function loadFileLink(ctx: Context): Promise<Loaded> {
  const unavailable = (reason: string): Loaded => ({ preview: { type: 'unavailable', path: ctx.path, reason } });
  const resolved = resolveRequestedPath(ctx.path);
  if ('reason' in resolved) return unavailable(resolved.reason);
  if (!isAbsolute(resolved.path) && !ctx.workingDirectory) return unavailable('This task has no working directory.');
  const target = resolve(ctx.workingDirectory ?? ctx.projectRoot, resolved.path);
  const working = ctx.workingDirectory ? resolve(ctx.workingDirectory) : undefined;
  const root = allowedRoot(target, ctx.workingDirectory, ctx.projectRoot);
  if (!root) return publishedArtifact(ctx, target);
  if (privatePath(root, target)) {
    return unavailable('Git internals and private Cezar state are not available through file links.');
  }
  try {
    return await readLinkedFile(ctx, root, target, working);
  } catch { return unavailable('The file or its working directory is missing or cannot be read.'); }
}
export async function resolveFileLink(ctx: Context): Promise<FileLinkResult> { return (await loadFileLink(ctx)).preview; }
