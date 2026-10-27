import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture } from './service.testkit.ts';
import { parentFileSnapshotPath, prepareWorkerContext, verifyWorkerContext } from './context.ts';
import { ensureOwnedWorkspace, planOwnedWorkspace } from './workspace.ts';
import type { WorkerSpawnRequest } from '@open-mercato/cezar-contract';

// A one-shot hook around `open`: it may change the filesystem just before a matching path is
// opened and return a step that runs right after, so a race lands between the canonical checks.
const openHook = vi.hoisted(() => ({ current: undefined as undefined | ((path: string) => (() => void) | undefined) }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open = (async (path: Parameters<typeof actual.open>[0], ...rest: unknown[]) => {
    const after = openHook.current?.(String(path));
    try { return await (actual.open as (...args: unknown[]) => ReturnType<typeof actual.open>)(path, ...rest); } finally { after?.(); }
  }) as typeof actual.open;
  return { ...actual, open, default: { ...actual, open } };
});

describe('explicit owned worker context', () => {
  let f: ReturnType<typeof fixture>;
  const input = (context: WorkerSpawnRequest['context']) => ({ task: 'inspect', baseline: 'parent-head', requestId: randomUUID(), context });
  const attachment = (name = 'document.txt', content: string | Buffer = 'parent document') => {
    const dir = join(f.root, '.ai/cezar/runs', `${f.parent.id}-images`); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), content); return join(dir, name);
  };
  beforeEach(() => { vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); });
  afterEach(async () => { openHook.current = undefined; await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const swapAttachmentAncestorDuringOpen = (source: string, content: string) => {
    const outside = join(f.root, 'outside-attachments');
    mkdirSync(outside);
    writeFileSync(join(outside, 'document.txt'), content);
    const ancestor = dirname(source);
    openHook.current = path => {
      if (path !== source) return undefined;
      openHook.current = undefined;
      renameSync(ancestor, `${ancestor}.real`);
      symlinkSync(outside, ancestor);
      return () => { unlinkSync(ancestor); renameSync(`${ancestor}.real`, ancestor); };
    };
  };
  it('refuses parent-attachment preparation through an ancestor swapped during the read', async () => {
    const source = attachment();
    const dataDir = join(f.root, '.ai/cezar');
    const before = readdirSync(join(dataDir, 'runs')).sort();
    const workspace = await planOwnedWorkspace(f.root, randomUUID(), f.sha);
    swapAttachmentAncestorDuringOpen(source, 'outside document');
    await expect(prepareWorkerContext({ repoRoot: f.root, dataDir, parentId: f.parent.id, workspace, parentCwd: f.root,
      context: { artifacts: [{ kind: 'parent-attachment', id: 'document.txt' }] }, containsSecret: () => false }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    expect(openHook.current).toBeUndefined();
    expect(readFileSync(source, 'utf8')).toBe('parent document');
    expect(readdirSync(join(dataDir, 'runs')).sort()).toEqual(before);
    expect(() => lstatSync(join(dataDir, 'runs', `${workspace.ownerRunId}-images`))).toThrow();
  });
  it('refuses parent-attachment rebuild through an ancestor swapped during the read', async () => {
    const source = attachment();
    const { workerId } = await f.service.spawn(f.caller, input({ artifacts: [{ kind: 'parent-attachment', id: 'document.txt' }] }));
    const worker = f.store.getRun(workerId)!;
    if (worker.delegation?.role !== 'worker') throw Error('worker');
    const { context, workspace, parentRunId } = worker.delegation;
    const snapshot = context!.inputs[0]!.path;
    const dataDir = join(f.root, '.ai/cezar');
    rmSync(snapshot);
    // Identical outside bytes pass the hash check: only descriptor identity can refuse them.
    swapAttachmentAncestorDuringOpen(source, 'parent document');
    await expect(verifyWorkerContext({ dataDir, parentId: parentRunId, workspace, context })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(openHook.current).toBeUndefined();
    expect(readFileSync(source, 'utf8')).toBe('parent document');
    expect(() => lstatSync(snapshot)).toThrow();
    await expect(verifyWorkerContext({ dataDir, parentId: parentRunId, workspace, context })).resolves.toBeUndefined();
    expect(readFileSync(snapshot, 'utf8')).toBe('parent document');
  });
  it('pins repository references and copies parent attachments into owned input storage before enqueue', async () => {
    writeFileSync(join(f.root, 'source.txt'), 'committed');
    execFileSync('git', ['add', 'source.txt'], { cwd: f.root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'input'], { cwd: f.root });
    const source = attachment();
    const accepted = await f.service.spawn(f.caller, input({ text: 'selected notes', artifacts: [{ kind: 'baseline-file', path: 'source.txt' }, { kind: 'parent-attachment', id: 'document.txt' }] }));
    const worker = f.store.getRun(accepted.workerId)!;
    const inspected = await f.service.inspect(f.caller, { workerId: accepted.workerId });
    expect(inspected.inputs).toHaveLength(2);
    expect(inspected.inputs?.[0]?.path).toBe(join(worker.delegation?.role === 'worker' ? worker.delegation.workspace.path : '', 'source.txt'));
    const copy = inspected.inputs![1]!.path;
    expect(copy).toContain(`${worker.id}-images`); expect(readFileSync(copy, 'utf8')).toBe('parent document');
    rmSync(source); expect(readFileSync(copy, 'utf8')).toBe('parent document');
    expect(worker.task).toContain(copy); expect(worker.task).toContain('selected notes');
    await ensureOwnedWorkspace(f.root, worker);
    expect(readFileSync(inspected.inputs![0]!.path, 'utf8')).toBe('committed');
  });
  it('rejects a dangling input-copy symlink without replacing it during recovery', async () => {
    attachment();
    const { workerId } = await f.service.spawn(f.caller, input({ artifacts: [{ kind: 'parent-attachment', id: 'document.txt' }] }));
    const worker = f.store.getRun(workerId)!;
    if (worker.delegation?.role !== 'worker') throw Error('worker');
    const { context, workspace, parentRunId } = worker.delegation;
    const copy = context!.inputs[0]!.path;
    const missingTarget = join(f.root, 'missing-target');
    rmSync(copy); symlinkSync(missingTarget, copy);
    await expect(verifyWorkerContext({ dataDir: join(f.root, '.ai/cezar'), parentId: parentRunId, workspace, context })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(lstatSync(copy).isSymbolicLink()).toBe(true);
    expect(readlinkSync(copy)).toBe(missingTarget);
  });
  it('removes prepared copies when later validation or durable acceptance fails', async () => {
    attachment();
    const before = readdirSync(join(f.root, '.ai/cezar/runs')).sort();
    await expect(f.service.spawn(f.caller, input({ artifacts: [{ kind: 'parent-attachment', id: 'document.txt' }, { kind: 'baseline-file', path: 'absent' }] }))).rejects.toThrow();
    expect(readdirSync(join(f.root, '.ai/cezar/runs')).sort()).toEqual(before);
    vi.spyOn(f.store, 'createOwnedRun').mockImplementation(() => { throw Error('disk failure'); });
    await expect(f.service.spawn(f.caller, input({ artifacts: [{ kind: 'parent-attachment', id: 'document.txt' }] }))).rejects.toThrow('disk failure');
    expect(readdirSync(join(f.root, '.ai/cezar/runs')).sort()).toEqual(before);
  });
  it('rejects known credential bytes in binary attachments before publishing copies', async () => {
    f.store.registerSessionSecret(f.token);
    attachment('binary.bin', Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from(f.token), Buffer.from([0xfe])]));
    await expect(f.service.spawn(f.caller, input({ artifacts: [{ kind: 'parent-attachment', id: 'binary.bin' }] }))).rejects.toMatchObject({ code: 'invalid_input' });
    expect(f.store.listRuns()).toHaveLength(1);
  });
  it.each(['../outside', '/etc/passwd', 'a/../../outside', 'a\\b', 'missing.txt'])('rejects unsafe or missing baseline reference %s', async path => {
    await expect(f.service.spawn(f.caller, input({ artifacts: [{ kind: 'baseline-file', path }] }))).rejects.toThrow();
    expect(f.store.listRuns()).toHaveLength(1);
  });
  it('rejects committed symlinks and unrelated or redirected parent attachments', async () => {
    symlinkSync('/etc/passwd', join(f.root, 'escape'));
    execFileSync('git', ['add', 'escape'], { cwd: f.root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'symlink'], { cwd: f.root });
    await expect(f.service.spawn(f.caller, input({ artifacts: [{ kind: 'baseline-file', path: 'escape' }] }))).rejects.toMatchObject({ code: 'invalid_input' });
    const source = attachment(); rmSync(source); symlinkSync('/etc/passwd', source);
    for (const id of ['document.txt', '../other-images/document.txt', 'absent.txt']) {
      await expect(f.service.spawn(f.caller, input({ artifacts: [{ kind: 'parent-attachment', id }] }))).rejects.toThrow();
    }
    expect(f.store.listRuns()).toHaveLength(1);
  });
  it('bounds combined text, reference count, aggregate copied bytes and rejects credentials in context', async () => {
    attachment('large.bin', Buffer.alloc(8 * 1024 * 1024 + 1));
    f.store.registerSessionSecret(f.token);
    for (const context of [{ text: 'x'.repeat(100_000) }, { text: f.token }, { artifacts: Array.from({ length: 33 }, () => ({ kind: 'parent-attachment' as const, id: 'large.bin' })) }, { artifacts: [{ kind: 'parent-attachment' as const, id: 'large.bin' }] }]) {
      await expect(f.service.spawn(f.caller, input(context))).rejects.toThrow();
    }
    expect(f.store.listRuns()).toHaveLength(1);
  });
});

describe('parent-file references', () => {
  let f: ReturnType<typeof fixture>;
  const input = (context: WorkerSpawnRequest['context'], requestId = randomUUID()) => ({ task: 'inspect', baseline: 'parent-head', requestId, context });
  const files = (...paths: string[]) => ({ artifacts: paths.map(path => ({ kind: 'parent-file' as const, path })) });
  const commit = (path: string, content: string) => {
    mkdirSync(dirname(join(f.root, path)), { recursive: true }); writeFileSync(join(f.root, path), content);
    execFileSync('git', ['add', path], { cwd: f.root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', path], { cwd: f.root });
  };
  const write = (path: string, content: string | Buffer) => {
    mkdirSync(dirname(join(f.root, path)), { recursive: true }); writeFileSync(join(f.root, path), content);
  };
  const runsDir = () => readdirSync(join(f.root, '.ai/cezar/runs')).sort();
  const workerOf = (workerId: string) => {
    const worker = f.store.getRun(workerId)!;
    if (worker.delegation?.role !== 'worker') throw Error('worker');
    return { worker, delegation: worker.delegation };
  };
  /** While `qa/<file>` is opened, `qa` is a symlink to `elsewhere`; it is a real directory again before and after. */
  const swapAncestorDuringOpen = (file: string) => {
    openHook.current = path => {
      if (!path.endsWith(`/qa/${file}`)) return undefined;
      openHook.current = undefined;
      renameSync(join(f.root, 'qa'), join(f.root, 'qa.real')); symlinkSync(join(f.root, 'elsewhere'), join(f.root, 'qa'));
      return () => { unlinkSync(join(f.root, 'qa')); renameSync(join(f.root, 'qa.real'), join(f.root, 'qa')); };
    };
  };
  beforeEach(() => { vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); });
  afterEach(async () => { openHook.current = undefined; await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('snapshots ignored parent files with worker-worktree recipe paths', async () => {
    commit('.gitignore', 'qa/\n');
    write('qa/1149/brief.md', 'the brief'); write('qa/notes.txt', 'notes');
    const { workerId } = await f.service.spawn(f.caller, input(files('qa/1149/brief.md', 'qa/notes.txt')));
    const { worker, delegation } = workerOf(workerId);
    const inspected = await f.service.inspect(f.caller, { workerId });
    expect(inspected.inputs?.map(entry => entry.path)).toEqual([join(delegation.workspace.path, 'qa/1149/brief.md'), join(delegation.workspace.path, 'qa/notes.txt')]);
    expect(worker.task).toContain(JSON.stringify(join(delegation.workspace.path, 'qa/1149/brief.md')));
    expect(worker.task).toContain(JSON.stringify(join(delegation.workspace.path, 'qa/notes.txt')));
    const dataDir = join(f.root, '.ai/cezar');
    const brief = await parentFileSnapshotPath(dataDir, delegation.workspace, 0);
    expect(brief).toContain(`${worker.id}-images`);
    expect(readFileSync(brief, 'utf8')).toBe('the brief');
    expect(readFileSync(await parentFileSnapshotPath(dataDir, delegation.workspace, 1), 'utf8')).toBe('notes');
    write('qa/1149/brief.md', 'edited after spawn');
    expect(readFileSync(brief, 'utf8')).toBe('the brief');
  });

  it('refuses tracked and unignored paths with a commit-it-instead message', async () => {
    commit('tracked.txt', 'tracked');
    await expect(f.service.spawn(f.caller, input(files('tracked.txt')))).rejects.toThrow(/tracked by git: tracked\.txt.*commit/);
    write('loose.txt', 'loose');
    await expect(f.service.spawn(f.caller, input(files('loose.txt')))).rejects.toThrow(/not ignored by git: loose\.txt.*commit/);
    commit('.gitignore', 'qa/**\n!qa/*.md\n');
    write('qa/keep.md', 're-included'); write('qa/other.txt', 'ignored');
    await expect(f.service.spawn(f.caller, input(files('qa/other.txt', 'qa/keep.md')))).rejects.toThrow(/not ignored by git: qa\/keep\.md.*commit/);
    expect(f.store.listRuns()).toHaveLength(1);
  });

  it('refuses an attached .gitignore even when the request schema was bypassed', async () => {
    // A later attachment that is a `.gitignore` could re-include an earlier one in the worker worktree.
    commit('.gitignore', 'qa/\n');
    write('qa/.GitIgnore', '!x\n');
    const before = runsDir();
    const workspace = await planOwnedWorkspace(f.root, randomUUID(), f.sha);
    await expect(prepareWorkerContext({ repoRoot: f.root, dataDir: join(f.root, '.ai/cezar'), parentId: f.parent.id, workspace, parentCwd: f.root,
      context: files('qa/.GitIgnore'), containsSecret: () => false }))
      .rejects.toMatchObject({ code: 'invalid_input', message: '--attach cannot attach a .gitignore: qa/.GitIgnore; ignore rules must come from the baseline' });
    expect(runsDir()).toEqual(before);
  });

  it('refuses missing, symlinked and directory parent files, naming the path', async () => {
    commit('.gitignore', 'qa/\n');
    write('qa/ok.md', 'fine'); write('elsewhere/secret.md', 'outside qa'); mkdirSync(join(f.root, 'qa/dir'));
    symlinkSync('../elsewhere', join(f.root, 'qa/link'));
    const before = runsDir();
    await expect(f.service.spawn(f.caller, input(files('qa/ok.md', 'qa/absent.md')))).rejects.toThrow('--attach path not found: qa/absent.md');
    write('qa/plain-file', 'a file, not a directory');
    await expect(f.service.spawn(f.caller, input(files('qa/ok.md', 'qa/plain-file/brief.md')))).rejects.toThrow('--attach path not found: qa/plain-file/brief.md');
    for (const path of ['qa/link/secret.md', 'qa/link', 'qa/dir']) {
      await expect(f.service.spawn(f.caller, input(files('qa/ok.md', path)))).rejects.toThrow(`--attach path is not a regular file inside the parent worktree: ${path}`);
    }
    expect(runsDir()).toEqual(before);
    expect(f.store.listRuns()).toHaveLength(1);
  });

  it('binds the read bytes to the canonical source, refusing an ancestor swapped for a symlink during the read', async () => {
    commit('.gitignore', 'qa/\n');
    write('qa/brief.md', 'inside bytes'); write('elsewhere/brief.md', 'OUTSIDE bytes');
    const before = runsDir();
    swapAncestorDuringOpen('brief.md');
    await expect(f.service.spawn(f.caller, input(files('qa/brief.md')))).rejects.toThrow('--attach path changed while it was read: qa/brief.md');
    expect(openHook.current).toBeUndefined();
    expect(readFileSync(join(f.root, 'qa/brief.md'), 'utf8')).toBe('inside bytes');
    expect(runsDir()).toEqual(before);
    expect(f.store.listRuns()).toHaveLength(1);
    // A source removed while it is opened is named too, not folded into the generic refusal.
    openHook.current = path => { if (path.endsWith('/qa/brief.md')) { openHook.current = undefined; rmSync(path); } return undefined; };
    await expect(f.service.spawn(f.caller, input(files('qa/brief.md')))).rejects.toThrow('--attach path not found: qa/brief.md');
    expect(runsDir()).toEqual(before);
  });

  it('refuses to rebuild a missing snapshot through an ancestor swapped for a symlink during the read', async () => {
    commit('.gitignore', 'qa/\n');
    // Identical bytes outside: the hash check alone cannot tell where they came from.
    write('qa/brief.md', 'same bytes'); write('elsewhere/brief.md', 'same bytes');
    const { workerId } = await f.service.spawn(f.caller, input(files('qa/brief.md')));
    const { context, workspace, parentRunId } = workerOf(workerId).delegation;
    const dataDir = join(f.root, '.ai/cezar');
    const snapshot = await parentFileSnapshotPath(dataDir, workspace, 0);
    rmSync(snapshot);
    swapAncestorDuringOpen('brief.md');
    await expect(verifyWorkerContext({ dataDir, parentId: parentRunId, workspace, context, parentCwd: f.root })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(openHook.current).toBeUndefined();
    expect(() => lstatSync(snapshot)).toThrow();
    await expect(verifyWorkerContext({ dataDir, parentId: parentRunId, workspace, context, parentCwd: f.root })).resolves.toBeUndefined();
    expect(readFileSync(snapshot, 'utf8')).toBe('same bytes');
  });

  it('names the attachment whose missing snapshot cannot be rebuilt because its parent source is gone', async () => {
    commit('.gitignore', 'qa/\n');
    write('qa/brief.md', 'brief'); write('qa/notes.md', 'notes');
    const { workerId } = await f.service.spawn(f.caller, input(files('qa/brief.md', 'qa/notes.md')));
    const { context, workspace, parentRunId } = workerOf(workerId).delegation;
    const dataDir = join(f.root, '.ai/cezar');
    rmSync(await parentFileSnapshotPath(dataDir, workspace, 1));
    rmSync(join(f.root, 'qa/notes.md'));
    await expect(verifyWorkerContext({ dataDir, parentId: parentRunId, workspace, context, parentCwd: f.root }))
      .rejects.toMatchObject({ code: 'invalid_input', message: '--attach path not found: qa/notes.md' });
  });

  it('shares the 8 MiB budget and refuses credentials', async () => {
    commit('.gitignore', 'qa/\n');
    const images = join(f.root, '.ai/cezar/runs', `${f.parent.id}-images`); mkdirSync(images, { recursive: true });
    writeFileSync(join(images, 'large.bin'), Buffer.alloc(5 * 1024 * 1024));
    write('qa/large.bin', Buffer.alloc(4 * 1024 * 1024));
    const before = runsDir();
    await expect(f.service.spawn(f.caller, input({ artifacts: [{ kind: 'parent-attachment', id: 'large.bin' }, { kind: 'parent-file', path: 'qa/large.bin' }] }))).rejects.toMatchObject({ code: 'invalid_input' });
    expect(runsDir()).toEqual(before);
    f.store.registerSessionSecret(f.token);
    write('qa/leak.md', `token ${f.token}`);
    await expect(f.service.spawn(f.caller, input(files('qa/leak.md')))).rejects.toMatchObject({ code: 'invalid_input' });
    expect(f.store.listRuns()).toHaveLength(1);
  });

  it('replays a retried request id without rereading the file', async () => {
    commit('.gitignore', 'qa/\n');
    write('qa/brief.md', 'brief');
    const requestId = randomUUID();
    const first = await f.service.spawn(f.caller, input(files('qa/brief.md'), requestId));
    rmSync(join(f.root, 'qa/brief.md'));
    await expect(f.service.spawn(f.caller, input(files('qa/brief.md'), requestId))).resolves.toEqual(first);
  });

  it('verifyWorkerContext trusts an intact parent-file snapshot without requiring the worktree copy', async () => {
    commit('.gitignore', 'qa/\n');
    write('qa/brief.md', 'brief');
    const { workerId } = await f.service.spawn(f.caller, input(files('qa/brief.md')));
    const { delegation } = workerOf(workerId);
    const { context, workspace, parentRunId } = delegation;
    const dataDir = join(f.root, '.ai/cezar');
    expect(() => lstatSync(context!.inputs[0]!.path)).toThrow();
    await expect(verifyWorkerContext({ dataDir, parentId: parentRunId, workspace, context })).resolves.toBeUndefined();
    // A missing snapshot is rebuilt only from identical parent-worktree bytes, and only when the parent cwd is known.
    const snapshot = await parentFileSnapshotPath(dataDir, workspace, 0);
    rmSync(snapshot);
    await expect(verifyWorkerContext({ dataDir, parentId: parentRunId, workspace, context })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(verifyWorkerContext({ dataDir, parentId: parentRunId, workspace, context, parentCwd: f.root })).resolves.toBeUndefined();
    expect(readFileSync(snapshot, 'utf8')).toBe('brief');
    rmSync(snapshot); write('qa/brief.md', 'changed');
    await expect(verifyWorkerContext({ dataDir, parentId: parentRunId, workspace, context, parentCwd: f.root })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(() => lstatSync(snapshot)).toThrow();
    // A modified snapshot is tampering, never repaired.
    write('qa/brief.md', 'brief');
    await verifyWorkerContext({ dataDir, parentId: parentRunId, workspace, context, parentCwd: f.root });
    writeFileSync(snapshot, 'tampered');
    await expect(verifyWorkerContext({ dataDir, parentId: parentRunId, workspace, context, parentCwd: f.root })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(readFileSync(snapshot, 'utf8')).toBe('tampered');
  });
});
