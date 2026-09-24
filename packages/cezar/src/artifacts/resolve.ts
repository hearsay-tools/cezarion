import { constants } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileLinkResult, FilePreviewData, PublishedArtifact } from '@open-mercato/cezar-contract';
import { FILE_CONTENT_CAP, imageMimeType, isOsOpenableImage } from '../server/git-changes.ts';
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

/** No outside source is opened or even stat'ed: it can only match a published snapshot. */
export async function loadFileLink(ctx: Context): Promise<Loaded> {
  const unavailable = (reason: string): Loaded => ({ preview: { type: 'unavailable', path: ctx.path, reason } });
  let path: string;
  try {
    if (!ctx.path || ctx.path.length > 8192 || /[\u0000-\u001f]/.test(ctx.path)) return unavailable('Invalid file path.');
    if (/^file:/i.test(ctx.path)) path = fileURLToPath(new URL(ctx.path));
    else {
      if (/^[a-z][a-z\d+.-]*:/i.test(ctx.path) && !/^[a-z]:[\\/]/i.test(ctx.path)) return unavailable('Not a local file path.');
      // Query decoding has already happened. This is a literal filesystem path;
      // decoding it again would turn a filename containing %20 into a space.
      path = ctx.path;
    }
    if (/[\u0000-\u001f]/.test(path) || path.startsWith('//') || path.startsWith('\\\\')) return unavailable('Network file paths are not supported.');
    if (process.platform !== 'win32' && /^[a-z]:[\\/]/i.test(path)) return unavailable('This path belongs to a different operating system.');
  } catch { return unavailable('Invalid local file URL or encoding.'); }
  if (!isAbsolute(path) && !ctx.workingDirectory) return unavailable('This task has no working directory.');
  const target = resolve(ctx.workingDirectory ?? ctx.projectRoot, path);
  const working = ctx.workingDirectory ? resolve(ctx.workingDirectory) : undefined;
  const project = resolve(ctx.projectRoot);
  const root = working && contained(working, target) ? working : contained(project, target) ? project : undefined;
  if (!root) {
    const directory = artifactDirectory(ctx.dataDir, ctx.runId);
    const matches = (await listArtifacts(directory, ctx.runId)).filter(item => item.sourcePath === target)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const entry = matches[0] ? await readArtifact(directory, ctx.runId, matches[0].id) : null;
    if (entry) return { preview: artifactPreview(entry.metadata, entry.bytes), ...(rasterMime(entry.metadata.name) ? { imageBytes: entry.bytes } : {}) };
    return { preview: { type: 'unpublished', path: ctx.path, reason: 'This file is outside the project. Ask the agent to publish it with cez artifact publish <path> and share the returned link.' } };
  }
  if (privatePath(root, target)) {
    return unavailable('Git internals and private Cezar state are not available through file links.');
  }
  try {
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
      const bytes = Buffer.alloc(Math.min(stat.size, cap) + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const sample = bytes.subarray(0, length);
      const binary = sample.subarray(0, 8192).includes(0);
      const tooLarge = stat.size > FILE_CONTENT_CAP || length > FILE_CONTENT_CAP;
      const preview: FilePreviewData = { type: 'file', source: root === working ? 'worktree' : 'project', path: target, size: stat.size, binary, tooLarge,
        ...(!binary && !tooLarge ? { content: sample.toString('utf8') } : {}) };
      return { preview, ...(raster && stat.size <= IMAGE_CAP && length <= IMAGE_CAP ? { imageBytes: sample } : {}) };
    } finally { await handle.close(); }
  } catch { return unavailable('The file or its working directory is missing or cannot be read.'); }
}
export async function resolveFileLink(ctx: Context): Promise<FileLinkResult> { return (await loadFileLink(ctx)).preview; }
