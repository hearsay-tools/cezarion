import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture } from './service.testkit.ts';
import { ensureOwnedWorkspace } from './workspace.ts';
import type { WorkerSpawnRequest } from '@open-mercato/cezar-contract';

describe('explicit owned worker context', () => {
  let f: ReturnType<typeof fixture>;
  const input = (context: WorkerSpawnRequest['context']) => ({ task: 'inspect', baseline: 'parent-head', requestId: randomUUID(), context });
  const attachment = (name = 'document.txt', content: string | Buffer = 'parent document') => {
    const dir = join(f.root, '.ai/cezar/runs', `${f.parent.id}-images`); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), content); return join(dir, name);
  };
  beforeEach(() => { vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); });
  afterEach(() => { f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
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
