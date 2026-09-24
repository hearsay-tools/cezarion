import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual };
});
import { mkdtemp, mkdir, rm, writeFile, symlink, readFile, link, truncate } from 'node:fs/promises';
import { execFileSync, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { artifactDirectory, listArtifacts, publishArtifact, readArtifact } from './store.ts';

let root: string;
let dir: string;
let runId: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cez-artifacts-'));
  runId = randomUUID();
  dir = artifactDirectory(root, runId);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const source = join(root, 'report.md');
  await writeFile(source, 'original');
  const metadata = await publishArtifact(dir, runId, source);
  return { source, metadata, entry: join(dir, metadata.id) };
}

describe('publication limits and locking', () => {
  it('rejects a source above the file cap before reading its bytes', async () => {
    const source = join(root, 'huge'); await writeFile(source, '');
    await truncate(source, 10 * 1024 * 1024 + 1);
    await expect(publishArtifact(dir, runId, source)).rejects.toThrow();
    expect(await listArtifacts(dir, runId)).toEqual([]);
  });
  it('cleans crashed temporary publications under the exclusive lock without evicting snapshots', async () => {
    const { source, metadata } = await fixture();
    const pending = join(dir, `.pending-${randomUUID()}`); await mkdir(pending);
    await writeFile(join(pending, 'content'), 'unfinished');
    await publishArtifact(dir, runId, source);
    await expect(readFile(join(pending, 'content'))).rejects.toThrow();
    expect((await readArtifact(dir, runId, metadata.id))?.bytes.toString()).toBe('original');
  });
  it('accounts for interrupted entries rather than trusting only valid metadata', async () => {
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 64; i++) await mkdir(join(dir, randomUUID()));
    const source = join(root, 'report.md'); await writeFile(source, 'original');
    await expect(publishArtifact(dir, runId, source)).rejects.toThrow(/limit/i);
  });
  it('serializes concurrent processes at the final available slot', async () => {
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 63; i++) await mkdir(join(dir, randomUUID()));
    const source = join(root, 'report.md'); await writeFile(source, 'original');
    const script = `import { publishArtifact } from ${JSON.stringify(new URL('./store.ts', import.meta.url).href)}; await publishArtifact(${JSON.stringify(dir)}, ${JSON.stringify(runId)}, ${JSON.stringify(source)});`;
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script])));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await listArtifacts(dir, runId)).toHaveLength(1);
  }, 15000);
  it('refuses an over-limit persisted list rather than returning unbounded metadata', async () => {
    const { metadata } = await fixture();
    for (let i = 0; i < 64; i++) {
      const id = randomUUID(); const entry = join(dir, id); await mkdir(entry);
      await writeFile(join(entry, 'content'), 'original');
      await writeFile(join(entry, 'metadata.json'), JSON.stringify({ ...metadata, id }));
    }
    expect(await listArtifacts(dir, runId)).toEqual([]);
    expect((await readArtifact(dir, runId, metadata.id))?.bytes.toString()).toBe('original');
  });
  it('counts stored bytes even when metadata is corrupt', async () => {
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 7; i++) {
      const entry = join(dir, randomUUID()); await mkdir(entry);
      await writeFile(join(entry, 'content'), ''); await truncate(join(entry, 'content'), (i === 6 ? 4 : 10) * 1024 * 1024);
    }
    const source = join(root, 'report.md'); await writeFile(source, 'original');
    await expect(publishArtifact(dir, runId, source)).rejects.toThrow(/limit/i);
  });
  it('reclaims a lock only when its local owner is definitely dead', async () => {
    const dead = spawnSync(process.execPath, ['-e', '']);
    await mkdir(join(dir, '.publish.lock'), { recursive: true });
    await writeFile(join(dir, '.publish.lock', 'owner.json'), JSON.stringify({ pid: dead.pid, host: hostname() }));
    const source = join(root, 'report.md'); await writeFile(source, 'original');
    await publishArtifact(dir, runId, source);
    await expect(readFile(join(dir, '.publish.lock', 'owner.json'))).rejects.toThrow();
  });
  it.each(['empty', 'malformed', 'foreign'])('does not replace an %s lock without proving a dead local owner', async kind => {
    await mkdir(join(dir, '.publish.lock'), { recursive: true });
    if (kind !== 'empty') await writeFile(join(dir, '.publish.lock', 'owner.json'), kind === 'malformed' ? '{' : JSON.stringify({ pid: 2147483647, host: 'another-host' }));
    const source = join(root, 'report.md'); await writeFile(source, 'original');
    let completed = false;
    const publication = publishArtifact(dir, runId, source).then(value => { completed = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 75));
    const publishedEarly = completed;
    await rm(join(dir, '.publish.lock'), { recursive: true, force: true });
    await publication;
    expect(publishedEarly).toBe(false);
  });
  it('does not steal a live lock based on elapsed time', async () => {
    await mkdir(join(dir, '.publish.lock'), { recursive: true });
    await writeFile(join(dir, '.publish.lock', 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname() }));
    const source = join(root, 'report.md'); await writeFile(source, 'original');
    let completed = false;
    const publication = publishArtifact(dir, runId, source).then(value => { completed = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 75));
    const publishedEarly = completed;
    await rm(join(dir, '.publish.lock'), { recursive: true });
    await publication;
    expect(publishedEarly).toBe(false);
  });
});

describe('source mutation defenses', () => {
  it.each(['same-size', 'growth', 'replacement'] as const)('rejects %s mutation during the descriptor read', async mutation => {
    const source = join(root, 'report.md'); await writeFile(source, 'original');
    const actualOpen = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await actualOpen(...args);
      if (args[0] === source) {
        const actualRead = file.read;
        let changed = false;
        Object.defineProperty(file, 'read', { value: async (...readArgs: unknown[]) => {
          const result = await Reflect.apply(actualRead, file, readArgs);
          if (!changed) {
            changed = true;
            if (mutation === 'replacement') await rm(source);
            await writeFile(source, mutation === 'growth' ? 'original-and-more' : 'modified');
          }
          return result;
        } });
      }
      return file;
    });
    await expect(publishArtifact(dir, runId, source)).rejects.toThrow(/changed/i);
    expect(await listArtifacts(dir, runId)).toEqual([]);
  });
  it('rejects same-size mutation when timestamps cannot observe it', async () => {
    // Regression: filesystems with coarse timestamp granularity report identical
    // mtime/ctime for a rewrite inside one tick, so the stat snapshot alone cannot
    // see a same-size mutation. Freeze the observed stat to simulate that filesystem.
    const source = join(root, 'report.md'); await writeFile(source, 'original');
    const actualOpen = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await actualOpen(...args);
      if (args[0] === source) {
        const actualRead = file.read;
        const actualStat = file.stat;
        let frozen: Awaited<ReturnType<typeof file.stat>> | undefined;
        Object.defineProperty(file, 'stat', { value: async (...statArgs: unknown[]) => {
          frozen ??= await Reflect.apply(actualStat, file, statArgs);
          return frozen;
        } });
        let changed = false;
        Object.defineProperty(file, 'read', { value: async (...readArgs: unknown[]) => {
          const result = await Reflect.apply(actualRead, file, readArgs);
          if (!changed) {
            changed = true;
            await writeFile(source, 'modified');
          }
          return result;
        } });
      }
      return file;
    });
    await expect(publishArtifact(dir, runId, source)).rejects.toThrow(/changed/i);
    expect(await listArtifacts(dir, runId)).toEqual([]);
  });
});

describe('storage validation', () => {
  it('selects task-history-owned storage independently of the worktree', () => {
    expect(artifactDirectory(root, runId)).toBe(join(root, 'runs', `${runId}-artifacts`));
  });
  it('rejects invalid run IDs before selecting storage', () => {
    expect(() => artifactDirectory(root, '../escape')).toThrow();
  });
  it('rejects mismatched run context', async () => {
    const { source } = await fixture();
    await expect(publishArtifact(dir, randomUUID(), source)).rejects.toThrow();
  });
  it('does not allow metadata to select a path', async () => {
    const { entry, metadata } = await fixture();
    const json = JSON.parse(await readFile(join(entry, 'metadata.json'), 'utf8'));
    await writeFile(join(entry, 'metadata.json'), JSON.stringify({ ...json, sourcePath: '/etc/passwd' }));
    expect((await readArtifact(dir, runId, metadata.id))?.bytes.toString()).toBe('original');
  });
  it('rejects changed bytes even when their size is unchanged', async () => {
    const { entry, metadata } = await fixture();
    await writeFile(join(entry, 'content'), 'modified');
    expect(await readArtifact(dir, runId, metadata.id)).toBeNull();
    expect(await listArtifacts(dir, runId)).toEqual([]);
  });
  it('rejects size mismatches', async () => {
    const { entry, metadata } = await fixture();
    await writeFile(join(entry, 'content'), 'truncated');
    expect(await readArtifact(dir, runId, metadata.id)).toBeNull();
  });
  it('hides complete-looking temporary entries and rejects invalid requested IDs', async () => {
    const { metadata, entry } = await fixture();
    await fs.rename(entry, join(dir, `.pending-${metadata.id}`));
    expect(await listArtifacts(dir, runId)).toEqual([]);
    expect(await readArtifact(dir, runId, `../.pending-${metadata.id}`)).toBeNull();
    expect(await readArtifact(dir, runId, metadata.id)).toBeNull();
  });
  it('rejects metadata from another task or artifact', async () => {
    const { metadata, entry } = await fixture();
    for (const patch of [{ runId: randomUUID() }, { id: randomUUID() }, { sourcePath: 'relative' }, { name: 'x'.repeat(256) }]) {
      await writeFile(join(entry, 'metadata.json'), JSON.stringify({ ...metadata, ...patch }));
      expect(await readArtifact(dir, runId, metadata.id)).toBeNull();
    }
  });
  it('rejects interrupted entries and corrupt or oversized metadata', async () => {
    await mkdir(dir, { recursive: true });
    const id = randomUUID();
    await mkdir(join(dir, id));
    await writeFile(join(dir, id, 'metadata.json'), '{}');
    expect(await readArtifact(dir, runId, id)).toBeNull();
    await writeFile(join(dir, id, 'metadata.json'), ' '.repeat(64 * 1024));
    expect(await listArtifacts(dir, runId)).toEqual([]);
  });
  it('rejects symlinked content and metadata', async () => {
    const { entry, metadata, source } = await fixture();
    await rm(join(entry, 'content')); await symlink(source, join(entry, 'content'));
    expect(await readArtifact(dir, runId, metadata.id)).toBeNull();
    await rm(join(entry, 'content')); await writeFile(join(entry, 'content'), 'original');
    await renameMetadata();
    async function renameMetadata() {
      const json = await readFile(join(entry, 'metadata.json'));
      const external = join(root, 'metadata.json'); await writeFile(external, json);
      await rm(join(entry, 'metadata.json')); await symlink(external, join(entry, 'metadata.json'));
    }
    expect(await readArtifact(dir, runId, metadata.id)).toBeNull();
  });
  it('rejects hardlinked stored files', async () => {
    const { entry, metadata } = await fixture();
    await link(join(entry, 'content'), join(root, 'mutable-copy'));
    expect(await readArtifact(dir, runId, metadata.id)).toBeNull();
  });
  it('rejects redirected artifact root and ancestors for reads and writes', async () => {
    const { source, metadata } = await fixture();
    const redirect = join(root, 'redirect'); await symlink(dir, redirect);
    expect(await readArtifact(redirect, runId, metadata.id)).toBeNull();
    await expect(publishArtifact(redirect, runId, source)).rejects.toThrow();
    const ancestor = join(root, 'ancestor'); await symlink(join(root, 'runs'), ancestor);
    await expect(publishArtifact(join(ancestor, `${runId}-artifacts`), runId, source)).rejects.toThrow();
  });
  it('rejects redirected entry directories', async () => {
    const { entry, metadata } = await fixture();
    const external = join(root, 'external'); await mkdir(external);
    await writeFile(join(external, 'content'), 'original');
    await writeFile(join(external, 'metadata.json'), JSON.stringify(metadata));
    await rm(entry, { recursive: true }); await symlink(external, entry);
    expect(await readArtifact(dir, runId, metadata.id)).toBeNull();
  });
  it('rejects non-regular and symlink sources without blocking', async () => {
    const { source } = await fixture();
    const symbolic = join(root, 'symbolic'); await symlink(source, symbolic);
    await expect(publishArtifact(dir, runId, symbolic)).rejects.toThrow();
    await expect(publishArtifact(dir, runId, root)).rejects.toThrow();
    const fifo = join(root, 'fifo'); execFileSync('mkfifo', [fifo]);
    await expect(publishArtifact(dir, runId, fifo)).rejects.toThrow();
  });
});

describe('immutable artifact publication', () => {
  it('keeps bytes after the original is removed', async () => {
    const source = join(root, 'report.md');
    await writeFile(source, 'original');
    const first = await publishArtifact(dir, runId, source);
    await rm(source);
    expect((await readArtifact(dir, runId, first.id))?.bytes.toString()).toBe('original');
    expect(await listArtifacts(dir, runId)).toEqual([first]);
  });
  it('preserves old IDs when republishing a changed file', async () => {
    const source = join(root, 'report.md');
    await writeFile(source, 'original');
    const first = await publishArtifact(dir, runId, source);
    await writeFile(source, 'changed');
    const second = await publishArtifact(dir, runId, source);
    expect(second.id).not.toBe(first.id);
    expect((await readArtifact(dir, runId, first.id))?.bytes.toString()).toBe('original');
    expect((await readArtifact(dir, runId, second.id))?.bytes.toString()).toBe('changed');
  });
  it('gives same-basename files distinct IDs', async () => {
    await mkdir(join(root, 'other'));
    const a = join(root, 'report.md');
    const b = join(root, 'other', 'report.md');
    await writeFile(a, 'first'); await writeFile(b, 'second');
    const first = await publishArtifact(dir, runId, a);
    const second = await publishArtifact(dir, runId, b);
    expect(first.id).not.toBe(second.id);
    expect((await readArtifact(dir, runId, first.id))?.bytes.toString()).toBe('first');
    expect((await readArtifact(dir, runId, second.id))?.bytes.toString()).toBe('second');
  });
});
