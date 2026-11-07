import { chmodSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { assertHomePath } from './boundary.ts';
import { privateDirectory, replacePrivate } from './private-files.ts';

/** All migration copies opt into private ACLs even before the release switch is enabled. */
export const migrationPrivacy = { layout: 'split' } as const;

export function insideDirectory(root: string, path: string): boolean {
  const part = relative(resolve(root), resolve(path));
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

/** Do not follow links while inventorying a home. The caller selects excluded subtrees. */
export function migrationFiles(root: string, exclude: (path: string) => boolean = () => false): string[] {
  const found: string[] = [];
  function visit(directory: string): void {
    let names: string[];
    try { names = readdirSync(directory).sort(); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && directory === root) return;
      throw error;
    }
    for (const name of names) {
      const path = join(directory, name);
      const key = relative(root, path).split(sep).join('/');
      if (exclude(key)) continue;
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile() || stat.isSymbolicLink()) found.push(key);
      else throw new Error(`Cannot migrate special file ${path}`);
    }
  }
  visit(root);
  return found;
}

/** Preserve internal links, including versions/current; refuse links to outside data. */
export function copyPrivateTree(source: string, target: string, executable = false): void {
  const canonical = realpathSync(source);
  privateDirectory(target, migrationPrivacy);
  for (const key of migrationFiles(source)) {
    const from = join(source, key), to = join(target, key);
    assertHomePath(target, dirname(to));
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) {
      const link = realpathSync(from);
      if (!insideDirectory(canonical, link)) throw new Error(`Migration link escapes source: ${from}`);
      const destination = join(target, relative(canonical, link));
      privateDirectory(dirname(to), migrationPrivacy);
      // The destination name belongs to a disposable pending copy, never the source.
      rmSync(to, { force: true });
      symlinkSync(relative(dirname(to), destination), to, lstatSync(link).isDirectory() ? 'dir' : 'file');
    } else {
      assertHomePath(target, to);
      replacePrivate(to, readFileSync(from), migrationPrivacy);
      if (executable && (stat.mode & 0o111)) chmodSync(to, 0o700);
    }
  }
}

/** ustar stores a UTF-8 name in 100 bytes and an optional 155-byte prefix. */
function archiveName(header: Buffer, key: string): void {
  if (Buffer.byteLength(key) <= 100) { header.write(key); return; }
  const splits = [...key.matchAll(/\//g)].map(match => match.index).reverse();
  const split = splits.find(index => Buffer.byteLength(key.slice(0, index)) <= 155 && Buffer.byteLength(key.slice(index + 1)) <= 100);
  if (split === undefined) throw new Error(`Path too long for migration archive: ${key}`);
  header.write(key.slice(split + 1), 0, 100);
  header.write(key.slice(0, split), 345, 155);
}

function tarEntry(root: string, key: string): Buffer[] {
  const path = join(root, key), stat = lstatSync(path);
  const link = stat.isSymbolicLink() ? readlinkSync(path) : undefined;
  const bytes = link === undefined ? readFileSync(path) : Buffer.alloc(0);
  if (link !== undefined && Buffer.byteLength(link) > 100) throw new Error(`Link too long for migration archive: ${path}`);
  const header = Buffer.alloc(512);
  archiveName(header, key);
  const octal = (value: number, at: number, width: number) => {
    const valueText = value.toString(8);
    if (valueText.length >= width) throw new Error(`File too large for migration archive: ${path}`);
    header.write(`${valueText.padStart(width - 1, '0')}\0`, at, width);
  };
  octal(0o600, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
  octal(bytes.length, 124, 12); octal(Math.floor(stat.mtimeMs / 1000), 136, 12);
  header.fill(32, 148, 156);
  header.write(link === undefined ? '0' : '2', 156);
  if (link !== undefined) header.write(link, 157, 100);
  header.write('ustar\0', 257); header.write('00', 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return [header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)];
}

/** Synchronous so the migration never yields while it holds the legacy write lock. */
export function writeLegacyArchive(root: string, path: string, files: readonly string[]): void {
  const blocks = files.flatMap(key => tarEntry(root, key));
  blocks.push(Buffer.alloc(1024));
  replacePrivate(path, gzipSync(Buffer.concat(blocks)), migrationPrivacy);
}
