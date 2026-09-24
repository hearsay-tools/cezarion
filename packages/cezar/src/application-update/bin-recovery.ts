import { chmod, lstat, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Builtins only: the helper is copied out of the package before npm replaces it.
type SavedBin = { name: string } & (
  | { kind: 'absent' }
  | { kind: 'link'; target: string }
  | { kind: 'file'; bytes: string; mode: number }
);
const validName = (name: unknown): name is string => typeof name === 'string' && /^[a-zA-Z0-9-]+$/.test(name);
const fail = (): never => { throw new Error('invalid recovery command snapshot'); };

/** Discovery already proved one of these two canonical global layouts. */
export function windowsGlobalLayout(prefix: string, outerRoot: string, outerPackage: string): boolean {
  return outerRoot === join(prefix, 'node_modules', outerPackage);
}

function filenames(names: string[], windows: boolean): string[] {
  if (!names.every(validName)) fail();
  return names.flatMap(name => windows ? [name, `${name}.cmd`, `${name}.ps1`] : [name]);
}

export async function snapshotGlobalBins(directory: string, names: string[], windows: boolean, destination: string,
  assertOwned: () => Promise<void>): Promise<void> {
  const entries: SavedBin[] = [];
  for (const name of filenames(names, windows)) {
    await assertOwned();
    const path = join(directory, name);
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error; // Permission and I/O failures must not become "absent".
    });
    if (!info) entries.push({ name, kind: 'absent' });
    else if (info.isSymbolicLink()) entries.push({ name, kind: 'link', target: await readlink(path) });
    else if (info.isFile()) entries.push({ name, kind: 'file', bytes: (await readFile(path)).toString('base64'), mode: info.mode & 0o777 });
    else throw new Error('unsupported npm command file');
  }
  await assertOwned();
  await writeFile(destination, JSON.stringify({ version: 1, windows, entries }), { mode: 0o600 });
}

/** Validate the entire private snapshot before touching any command path. */
export async function restoreGlobalBins(prefix: string, names: string[], windows: boolean, source: string,
  assertOwned: () => Promise<void>): Promise<void> {
  const raw: unknown = JSON.parse(await readFile(source, 'utf8'));
  const allowed = new Set(filenames(names, windows));
  let entries: SavedBin[];
  // Keep already-prepared POSIX updates resumable across this change.
  if (Array.isArray(raw)) {
    if (windows) fail();
    entries = raw.map((link: unknown) => {
      if (!link || typeof link !== 'object') return fail();
      const item = link as Record<string, unknown>;
      if (!allowed.has(item.name as string) || typeof item.target !== 'string') return fail();
      return { name: item.name as string, kind: 'link', target: item.target };
    });
  } else {
    if (!raw || typeof raw !== 'object') fail();
    const snapshot = raw as Record<string, unknown>;
    if (snapshot.version !== 1 || snapshot.windows !== windows || !Array.isArray(snapshot.entries)) fail();
    const seen = new Set<string>();
    entries = (snapshot.entries as unknown[]).map((value): SavedBin => {
      if (!value || typeof value !== 'object') return fail();
      const entry = value as Record<string, unknown>;
      if (typeof entry.name !== 'string' || !allowed.has(entry.name) || seen.has(entry.name)) return fail();
      seen.add(entry.name);
      if (entry.kind === 'absent') return { name: entry.name, kind: 'absent' };
      if (entry.kind === 'link' && typeof entry.target === 'string' && !entry.target.includes('\0')) {
        return { name: entry.name, kind: 'link', target: entry.target };
      }
      if (entry.kind === 'file' && typeof entry.bytes === 'string' && Buffer.from(entry.bytes, 'base64').toString('base64') === entry.bytes
        && typeof entry.mode === 'number' && Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777) {
        return { name: entry.name, kind: 'file', bytes: entry.bytes, mode: entry.mode };
      }
      return fail();
    });
    if (seen.size !== allowed.size) fail();
  }
  const directory = windows ? prefix : join(prefix, 'bin');
  for (const entry of entries) {
    await assertOwned();
    const path = join(directory, entry.name);
    await rm(path, { force: true }); // Do not follow replaced symlinks or remove directories.
    await assertOwned();
    if (entry.kind === 'link') await symlink(entry.target, path);
    if (entry.kind === 'file') {
      await writeFile(path, Buffer.from(entry.bytes, 'base64'), { mode: entry.mode, flag: 'wx' });
      await chmod(path, entry.mode);
    }
  }
}
