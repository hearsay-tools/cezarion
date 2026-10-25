import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fileIdentity,
  identityOf,
  LEGACY_SKILLS_MANIFEST_FILE,
  MANIFEST_FILE,
  withWorktreeFiles,
  type EntryContent,
  type PathState,
  type WorktreeFiles,
  type WorktreeFilesOptions,
  type WriteBoundary,
} from './worktree-manifest.ts';
import { readManifest } from './worktree-manifest.testkit.ts';

const execFileAsync = promisify(execFile);
/** The `tree:` identity a cezar before hearsay-tools/cezarion#1814 recorded for a file holding `text`. */
const legacyFileIdentity = (text: string) => `tree:${createHash('sha256').update(`F  ${text}\n`).digest('hex')}`;
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

describe('worktree manifest', { timeout: 30_000 }, () => {
  let main: string;
  let worktree: string;
  let gitDir: string;

  const git = async (cwd: string, ...args: string[]) => {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout;
  };
  const manifestFile = () => join(gitDir, MANIFEST_FILE);
  const writeManifest = (doc: unknown) => writeFileSync(manifestFile(), typeof doc === 'string' ? doc : JSON.stringify(doc));
  const pass = <T>(writer: 'skills' | 'seed', run: (files: WorktreeFiles) => Promise<T>, options: WorktreeFilesOptions = {}) =>
    withWorktreeFiles<T | 'fallback'>(worktree, writer, options, 'fallback', run);

  beforeEach(async () => {
    main = realpathSync(mkdtempSync(join(tmpdir(), 'cez-manifest-')));
    await git(main, 'init', '-q', '-b', 'main');
    writeFileSync(join(main, 'a.txt'), 'one\n');
    await git(main, 'add', '-A');
    await git(main, ...GIT_ID, 'commit', '-q', '-m', 'base');
    worktree = `${main}-wt`;
    await git(main, 'worktree', 'add', '-q', '-b', 'task', worktree);
    gitDir = (await git(worktree, 'rev-parse', '--absolute-git-dir')).trim();
  });

  afterEach(() => {
    rmSync(main, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it('records each write in the private git dir, with what it left there', async () => {
    await pass('seed', async (files) => {
      await files.put('conf/a.json', { type: 'file', text: '{}' }, { kind: 'file', source: 'catalog-id' });
      await files.put('skills/x', { type: 'dir', files: [{ name: 'SKILL.md', text: 'X' }] }, { kind: 'generated', skill: 'x' });
    });
    const doc = JSON.parse(readFileSync(manifestFile(), 'utf8')) as Record<string, unknown>;
    expect(doc).toEqual({
      version: 1,
      entries: [
        { path: 'conf/a.json', writer: 'seed', kind: 'file', source: 'catalog-id', identity: fileIdentity('{}') },
        { path: 'skills/x', writer: 'seed', kind: 'generated', skill: 'x', identity: await identityOf(join(worktree, 'skills/x')) },
      ],
    });
    expect(await identityOf(join(worktree, 'conf/a.json'))).toBe(fileIdentity('{}'));
    expect(readdirSync(worktree).sort()).toEqual(['.git', 'a.txt', 'conf', 'skills']);
    // The pass's staging dirs go with it.
    expect(readdirSync(join(gitDir, 'cezar-staging'))).toEqual([]);
  });

  it('keeps keys it does not know, and drops entries it cannot read', async () => {
    const kept = { path: 'kept.txt', writer: 'seed', kind: 'file', identity: fileIdentity('k'), hint: 'from a newer cezar' };
    writeManifest({
      version: 1,
      future: { x: 1 },
      skills: { roots: ['r', 3], later: true },
      entries: [kept, { path: '../out', writer: 'seed', kind: 'file', identity: 'tree:0' }, { path: 'no-identity' }, 'junk'],
    });
    await pass('seed', async (files) => files.save());
    expect(JSON.parse(readFileSync(manifestFile(), 'utf8'))).toEqual({
      future: { x: 1 },
      version: 1,
      entries: [kept],
      skills: { later: true, roots: ['r'] },
    });
  });

  it('removes the file once it lists nothing, and keeps it while it holds unknown keys', async () => {
    await pass('seed', async (files) => {
      await files.put('a.json', { type: 'file', text: '{}' }, { kind: 'file' });
      await files.remove('a.json');
      await files.save();
    });
    expect(existsSync(manifestFile())).toBe(false);
    writeManifest({ version: 1, entries: [], future: true });
    await pass('seed', async (files) => files.save());
    expect(JSON.parse(readFileSync(manifestFile(), 'utf8'))).toEqual({ future: true, version: 1, entries: [] });
  });

  it.each([
    ['missing', null],
    ['not JSON', '{oops'],
    ['missing its entries', '{"version":1}'],
  ])('a manifest that is %s lists nothing, and the next save replaces it', async (_case, text) => {
    if (text !== null) writeManifest(text);
    writeFileSync(join(worktree, 'there.txt'), 'the agent\n');
    await pass('seed', async (files) => {
      expect((await files.inspect('there.txt')).owner).toBe('theirs');
      expect((await files.inspect('free.txt')).owner).toBe('free');
      await expect(files.put('there.txt', { type: 'file', text: 'cezar' }, { kind: 'file' })).rejects.toThrow();
      await files.put('free.txt', { type: 'file', text: 'cezar' }, { kind: 'file' });
    });
    expect(readFileSync(join(worktree, 'there.txt'), 'utf8')).toBe('the agent\n');
    expect((await readManifest(worktree))?.entries.map((entry) => entry.path)).toEqual(['free.txt']);
  });

  it('writes nothing, and leaves the file, when a newer cezar wrote it', async () => {
    const newer = JSON.stringify({ version: 2, entries: [{ path: 'x', anything: true }] });
    writeManifest(newer);
    let ran = false;
    expect(await pass('seed', async () => { ran = true; })).toBe('fallback');
    expect(ran).toBe(false);
    expect(readFileSync(manifestFile(), 'utf8')).toBe(newer);
  });

  it('imports the legacy skills record for unlisted paths, then removes it', async () => {
    writeManifest({
      version: 1,
      entries: [{ path: 'both', writer: 'skills', kind: 'link', identity: 'link:/manifest' }],
      skills: { roots: ['a'] },
    });
    const legacy = join(gitDir, LEGACY_SKILLS_MANIFEST_FILE);
    writeFileSync(legacy, JSON.stringify({
      version: 1,
      roots: ['a', 'b'],
      entries: [
        { path: 'both', kind: 'link', identity: 'link:/legacy' },
        { path: 'only-legacy', kind: 'generated', skill: 'b', identity: 'tree:1' },
        { path: '../bad', kind: 'link', identity: 'link:/x' },
      ],
    }));
    await pass('skills', async (files) => {
      expect(files.roots).toEqual(['a', 'b']);
      expect(files.entries().map((entry) => [entry.path, entry.identity])).toEqual([['both', 'link:/manifest'], ['only-legacy', 'tree:1']]);
      await files.save();
    });
    expect(existsSync(legacy)).toBe(false);
    expect((await readManifest(worktree))?.entries).toEqual([
      { path: 'both', writer: 'skills', kind: 'link', identity: 'link:/manifest' },
      { path: 'only-legacy', writer: 'skills', kind: 'generated', skill: 'b', identity: 'tree:1' },
    ]);
  });

  it('never acts on another writer\'s path, an unknown kind or an identity it cannot check', async () => {
    for (const name of ['skills.txt', 'later.txt']) writeFileSync(join(worktree, name), 'x');
    mkdirSync(join(worktree, 'marked'));
    writeFileSync(join(worktree, 'marked', 'SKILL.md'), 'old');
    writeManifest({
      version: 1,
      entries: [
        { path: 'skills.txt', writer: 'skills', kind: 'file', identity: fileIdentity('x') },
        { path: 'later.txt', writer: 'seed', kind: 'kind-from-later', identity: fileIdentity('x') },
        { path: 'marked', writer: 'seed', kind: 'team-copy', identity: 'marker:{}' },
      ],
    });
    await pass('seed', async (files) => {
      for (const path of ['skills.txt', 'later.txt', 'marked']) {
        expect((await files.inspect(path)).owner, path).toBe('kept');
        expect(await files.remove(path), path).toBe(false);
        await expect(files.put(path, { type: 'file', text: 'y' }, { kind: 'file' }), path).rejects.toThrow();
      }
      expect(files.entries().map((entry) => entry.path)).toEqual(['later.txt', 'marked']);
    });
    expect(readFileSync(join(worktree, 'skills.txt'), 'utf8')).toBe('x');
    expect(readFileSync(join(worktree, 'marked', 'SKILL.md'), 'utf8')).toBe('old');
  });

  it('never writes or removes through a parent dir that leads out of the worktree', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cez-manifest-outside-'));
    try {
      writeFileSync(join(outside, 'x.txt'), 'outside');
      symlinkSync(outside, join(worktree, 'out'));
      writeManifest({ version: 1, entries: [{ path: 'out/x.txt', writer: 'seed', kind: 'file', identity: fileIdentity('outside') }] });
      await pass('seed', async (files) => {
        expect((await files.inspect('out/x.txt')).owner).toBe('outside');
        expect((await files.inspect('out/new.txt')).owner).toBe('outside');
        expect(await files.remove('out/x.txt')).toBe(false);
        await expect(files.put('out/new.txt', { type: 'file', text: 'y' }, { kind: 'file' })).rejects.toThrow();
      });
      expect(readdirSync(outside)).toEqual(['x.txt']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('tells two trees apart whose names and bytes run together the same way', async () => {
    mkdirSync(join(worktree, 'one'));
    writeFileSync(join(worktree, 'one', 'a'), '\nF b y');
    mkdirSync(join(worktree, 'two'));
    writeFileSync(join(worktree, 'two', 'a'), '');
    writeFileSync(join(worktree, 'two', 'b'), 'y');
    expect(await identityOf(join(worktree, 'one'))).not.toBe(await identityOf(join(worktree, 'two')));
  });

  it.skipIf(process.platform === 'win32')('never opens a special file the agent put in place of an entry', async () => {
    await pass('seed', (files) => files.put('a.json', { type: 'file', text: '{}' }, { kind: 'file' }));
    const fifo = join(worktree, 'a.json');
    rmSync(fifo);
    await execFileAsync('mkfifo', [fifo]);
    const inspected = pass('seed', (files) => files.inspect('a.json'));
    let timer: NodeJS.Timeout | undefined;
    // bound: a read of a FIFO with no writer never returns; 10 s is a hang guard far above the lstat the pass needs.
    const hung = new Promise<'hung'>((resolve) => { timer = setTimeout(() => resolve('hung'), 10_000); });
    const outcome = await Promise.race([inspected, hung]);
    clearTimeout(timer);
    // Release a read that blocked, so the pass and the worker can end.
    if (outcome === 'hung') closeSync(openSync(fifo, 'w'));
    expect(outcome).not.toBe('hung');
    expect((outcome as PathState).owner).toBe('theirs');
  });

  it('checks an identity from the legacy record in its older encoding, then records it in the new one', async () => {
    writeFileSync(join(worktree, 'kept.txt'), 'v1');
    writeFileSync(join(gitDir, LEGACY_SKILLS_MANIFEST_FILE), JSON.stringify({
      version: 1, roots: [], entries: [{ path: 'kept.txt', kind: 'ignore-file', identity: legacyFileIdentity('v1') }],
    }));
    await pass('skills', async (files) => {
      const state = await files.inspect('kept.txt');
      expect(state.owner).toBe('ours');
      expect(state.current).toBe(fileIdentity('v1'));
      expect(state.entry?.identity).toBe(fileIdentity('v1'));
      await files.save();
    });
    expect((await readManifest(worktree))?.entries[0]?.identity).toBe(fileIdentity('v1'));
    writeFileSync(join(worktree, 'kept.txt'), 'v2');
    await pass('skills', async (files) => expect((await files.inspect('kept.txt')).owner).toBe('theirs'));
  });

  // The Worktree cases rows for a crash inside one write, read from what the crash committed.
  const v1: EntryContent = { type: 'dir', files: [{ name: 'SKILL.md', text: 'v1' }] };
  const v2: EntryContent = { type: 'dir', files: [{ name: 'SKILL.md', text: 'v2' }] };
  const meta = { kind: 'generated' as const, skill: 'x' };
  const crashRows: Array<[WriteBoundary, { kind: string; onDisk: 'v1' | 'v2' | null; owner: string }]> = [
    ['staged', { kind: 'generated', onDisk: 'v1', owner: 'ours' }],
    ['pending', { kind: 'pending', onDisk: 'v1', owner: 'ours' }],
    ['cleared', { kind: 'pending', onDisk: null, owner: 'free' }],
    ['placed', { kind: 'pending', onDisk: 'v2', owner: 'ours' }],
  ];

  it.each(crashRows)('a rewrite that crashes at %s leaves a state the next pass repairs', async (boundary, row) => {
    const skillFile = join(worktree, 'skills', 'x', 'SKILL.md');
    const onDisk = () => (existsSync(skillFile) ? readFileSync(skillFile, 'utf8') : null);
    await pass('skills', (files) => files.put('skills/x', v1, meta));
    const first = (await readManifest(worktree))!.entries[0]!;
    let checked = false;
    const faults = async (at: WriteBoundary) => {
      if (at !== boundary) return;
      const entry = (await readManifest(worktree))!.entries[0]!;
      expect(entry.kind).toBe(row.kind);
      if (row.kind === 'pending') expect(entry.alternate).toBe(first.identity);
      expect(onDisk()).toBe(row.onDisk);
      if (boundary === 'staged') expect(readdirSync(join(gitDir, 'cezar-staging'))).toHaveLength(1);
      checked = true;
      throw new Error(`crash at ${boundary}`);
    };
    await expect(pass('skills', (files) => files.put('skills/x', v2, meta), { faults })).rejects.toThrow(`crash at ${boundary}`);
    expect(checked).toBe(true);
    await pass('skills', async (files) => {
      const state = await files.inspect('skills/x');
      expect(state.owner).toBe(row.owner);
      if (state.owner === 'ours' && state.current === state.entry?.identity && row.onDisk === 'v2') {
        files.record('skills/x', meta, state.current!);
        await files.save();
      } else await files.put('skills/x', v2, meta);
    });
    expect(onDisk()).toBe('v2');
    const [entry] = (await readManifest(worktree))!.entries;
    expect(entry).toMatchObject({ kind: 'generated', identity: await identityOf(join(worktree, 'skills', 'x')) });
    expect(entry?.alternate).toBeUndefined();
  });

  it('a removal that crashes before its save leaves an entry for a path the next pass may reuse', async () => {
    await pass('skills', (files) => files.put('skills/x', v1, meta));
    const faults = async (at: WriteBoundary) => {
      if (at !== 'removed') return;
      expect((await readManifest(worktree))?.entries.map((entry) => entry.path)).toEqual(['skills/x']);
      throw new Error('crash at removed');
    };
    await expect(pass('skills', (files) => files.remove('skills/x'), { faults })).rejects.toThrow('crash at removed');
    expect(existsSync(join(worktree, 'skills', 'x'))).toBe(false);
    await pass('skills', async (files) => {
      expect((await files.inspect('skills/x')).owner).toBe('free');
      files.forget('skills/x');
      await files.save();
    });
    expect(await readManifest(worktree)).toBeNull();
  });

  it('a file replaces a file in one rename, with no cleared step', async () => {
    const seen: WriteBoundary[] = [];
    const faults = (at: WriteBoundary) => { seen.push(at); };
    await pass('seed', (files) => files.put('a.json', { type: 'file', text: '1' }, { kind: 'file' }), { faults });
    await pass('seed', (files) => files.put('a.json', { type: 'file', text: '2' }, { kind: 'file' }), { faults });
    expect(seen).toEqual(['staged', 'pending', 'placed', 'staged', 'pending', 'placed']);
    expect(readFileSync(join(worktree, 'a.json'), 'utf8')).toBe('2');
  });

  it('sweeps staging dirs a dead process left, and keeps a live one\'s', async () => {
    const staging = join(gitDir, 'cezar-staging');
    // Above every Linux and macOS pid limit, so no process has it.
    const dead = join(staging, '2147483646-dead');
    const live = join(staging, `${process.ppid}-live`);
    for (const dir of [dead, live]) mkdirSync(dir, { recursive: true });
    await pass('seed', (files) => files.stagingDir());
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  it('runs one pass at a time per worktree, across writers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const seed = pass('seed', async (files) => {
      order.push('seed start');
      await files.put('seeded.json', { type: 'file', text: '{}' }, { kind: 'file' });
      await gate;
      order.push('seed end');
    });
    const skills = pass('skills', async (files) => {
      order.push('skills start');
      await files.put('skills/x', v1, meta);
    });
    release();
    await Promise.all([seed, skills]);
    expect(order).toEqual(['seed start', 'seed end', 'skills start']);
    expect((await readManifest(worktree))?.entries.map((entry) => [entry.path, entry.writer])).toEqual([
      ['seeded.json', 'seed'], ['skills/x', 'skills'],
    ]);
  });

  it('returns the fallback outside a git worktree', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cez-manifest-plain-'));
    try {
      expect(await withWorktreeFiles(plain, 'seed', {}, 'fallback', async () => 'ran')).toBe('fallback');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
