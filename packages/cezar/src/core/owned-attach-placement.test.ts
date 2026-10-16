import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { WorkerSpawnRequest } from '@open-mercato/cezar-contract';
import type { AgentRunResult, AgentRunSpec, AgentSession } from './agent-runner.ts';
import * as runners from './runner-factory.ts';
import { CLAUDE_SPEC_SUPPORT } from './claude-cli-runner.ts';
import { fixture } from '../delegation/service.testkit.ts';
import { placeWorkerAttachments } from '../delegation/context.ts';
import { ensureOwnedWorkspace, readOwnedDiff } from '../delegation/workspace.ts';
import { autosaveCommit } from '../git-worktree.ts';

const until = (predicate: () => boolean) => vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 15_000, interval: 10 });
const ATTACHED = { 'qa/1149/brief.md': 'the brief\n', 'qa/evidence.log': 'evidence bytes\n' } as const;

// Real acceptance, store, manager and worktree; only the agent wire is fake, and it records what
// the worker's worktree holds at the moment its session starts (hearsay-tools/cezarion#1149).
describe('attached parent files in the worker worktree', { timeout: 30_000 }, () => {
  let f: ReturnType<typeof fixture>;
  const seen: Array<{ spec: AgentRunSpec; files: Record<string, string | undefined>; finish(): void }> = [];
  const spawn = (paths: readonly string[]) => f.service.spawn(f.caller, { task: 'inspect', baseline: 'parent-head', requestId: randomUUID(),
    context: { artifacts: paths.map(path => ({ kind: 'parent-file' as const, path })) } satisfies WorkerSpawnRequest['context'] });
  const commit = (path: string, content: string) => {
    mkdirSync(dirname(join(f.root, path)), { recursive: true }); writeFileSync(join(f.root, path), content);
    execFileSync('git', ['add', path], { cwd: f.root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', path], { cwd: f.root });
  };
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(f.root, path)), { recursive: true }); writeFileSync(join(f.root, path), content);
  };
  const workerOf = (workerId: string) => {
    const worker = f.store.getRun(workerId)!;
    if (worker.delegation?.role !== 'worker') throw Error('worker');
    return { worker, delegation: worker.delegation };
  };
  const launch = async () => {
    (f.manager as unknown as { pump: MockInstance }).pump.mockRestore();
    await (f.manager as unknown as { pump(): Promise<void> }).pump();
  };
  beforeEach(() => {
    vi.stubEnv('CEZ_DELEGATION', '1'); vi.stubEnv('CEZ_DRY_RUN', '1'); vi.stubEnv('CEZ_AUTONAME', '0');
    f = fixture();
    vi.spyOn(runners, 'createRunner').mockImplementation(backend => ({ backend: backend ?? 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      interrupt: async () => {}, run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), startSession: spec => {
        const files = Object.fromEntries(Object.keys(ATTACHED).map(path => {
          const target = join(spec.cwd, path);
          return [path, existsSync(target) ? readFileSync(target, 'utf8') : undefined];
        }));
        let resolve!: (value: AgentRunResult) => void; let open = true;
        const result = new Promise<AgentRunResult>(done => { resolve = done; });
        const finish = () => { if (open) { open = false; resolve({ text: '', toolCalls: [], tokensUsed: 0 }); } };
        const session: AgentSession = { result, get open() { return open; }, sendMessage: () => open, sendAgentMessage: () => open ? Promise.resolve() : false,
          discardQueuedMessages: () => {}, holdsHumanInput: () => false, interrupt: finish, end: finish };
        seen.push({ spec, files, finish }); return session;
      } }));
  });
  afterEach(async () => {
    for (const s of seen) s.finish();
    seen.length = 0;
    await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  });

  it('attached ignored files exist in the worktree when the first agent turn starts', async () => {
    commit('.gitignore', 'qa/\n');
    for (const [path, content] of Object.entries(ATTACHED)) write(path, content);
    const { workerId } = await spawn(Object.keys(ATTACHED));
    await launch();
    await until(() => seen.length === 1);
    const { delegation } = workerOf(workerId);
    expect(seen[0]!.spec.cwd).toBe(delegation.workspace.path);
    expect(seen[0]!.files).toEqual(ATTACHED);
  });

  it('Continue does not restore an attached file the worker deleted', async () => {
    commit('.gitignore', 'qa/\n');
    for (const [path, content] of Object.entries(ATTACHED)) write(path, content);
    const { workerId } = await spawn(Object.keys(ATTACHED));
    await launch();
    await until(() => seen.length === 1);
    expect(seen[0]!.files['qa/1149/brief.md']).toBe(ATTACHED['qa/1149/brief.md']);
    rmSync(join(seen[0]!.spec.cwd, 'qa/1149/brief.md'));
    seen[0]!.finish();
    expect(await f.manager.awaitRunTermination(workerId, 15_000)).toBe(true);
    expect(f.manager.continueRun(workerId, { text: 'continue' }).ok).toBe(true);
    await until(() => seen.length === 2);
    expect(seen[1]!.files).toEqual({ 'qa/1149/brief.md': undefined, 'qa/evidence.log': ATTACHED['qa/evidence.log'] });
    expect(f.store.getRun(workerId)?.status).not.toBe('failed');
  });

  it('a worker re-queued past its first step does not get a deleted attachment back', async () => {
    commit('.gitignore', 'qa/\n');
    for (const [path, content] of Object.entries(ATTACHED)) write(path, content);
    const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'two-step.yaml'), ['name: two-step', 'steps:', '  - id: first', '    prompt: "{{task}}"', '  - id: second', '    prompt: "again"'].join('\n'));
    const { workerId } = await f.service.spawn(f.caller, { task: 'inspect', baseline: 'parent-head', requestId: randomUUID(), workflow: 'two-step',
      context: { artifacts: Object.keys(ATTACHED).map(path => ({ kind: 'parent-file' as const, path })) } });
    await launch();
    await until(() => seen.length === 1);
    rmSync(join(seen[0]!.spec.cwd, 'qa/1149/brief.md'));
    seen[0]!.finish();
    await until(() => seen.length === 2);
    seen[1]!.finish();
    expect(await f.manager.awaitRunTermination(workerId, 15_000)).toBe(true);
    // The durable shape a restart re-queues: the first step done, the second still pending.
    f.store.updateStep(workerId, 'second', { status: 'pending', finishedAt: undefined });
    f.store.updateRun(workerId, { status: 'queued', finishedAt: undefined, error: undefined });
    await (f.manager as unknown as { reviveQueuedRun(run: unknown, reason: string): Promise<void> }).reviveQueuedRun(f.store.getRun(workerId), 'cezar restarted');
    await (f.manager as unknown as { pump(): Promise<void> }).pump();
    await until(() => seen.length === 3);
    expect(seen[2]!.files).toEqual({ 'qa/1149/brief.md': undefined, 'qa/evidence.log': ATTACHED['qa/evidence.log'] });
  });

  it('placement keeps attached files out of the worker diff and autosave commits', async () => {
    commit('.gitignore', 'qa/\n');
    for (const [path, content] of Object.entries(ATTACHED)) write(path, content);
    const { workerId } = await spawn(Object.keys(ATTACHED));
    const { worker, delegation } = workerOf(workerId);
    const workspace = await ensureOwnedWorkspace(f.root, worker);
    await placeWorkerAttachments({ dataDir: join(f.root, '.ai/cezar'), workspace: delegation.workspace, context: delegation.context });
    for (const [path, content] of Object.entries(ATTACHED)) expect(readFileSync(join(workspace.path, path), 'utf8')).toBe(content);
    // A real change beside them, so the diff and the autosave have something to carry.
    writeFileSync(join(workspace.path, 'work.txt'), 'worker change\n');
    const { diff } = await readOwnedDiff(f.root, worker);
    expect(diff).toContain('work.txt');
    for (const path of Object.keys(ATTACHED)) expect(diff).not.toContain(path);
    expect(await autosaveCommit(workspace.path, 'turn end', { taskBranch: workspace.branch })).toBe('committed');
    const committed = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: workspace.path, encoding: 'utf8' }).trim().split('\n');
    expect(committed).toEqual(['work.txt']);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: workspace.path, encoding: 'utf8' })).toBe('');
  });

  it('placement does not overwrite an existing destination', async () => {
    commit('.gitignore', 'qa/\n');
    for (const [path, content] of Object.entries(ATTACHED)) write(path, content);
    const { workerId } = await spawn(Object.keys(ATTACHED));
    const { worker, delegation } = workerOf(workerId);
    const workspace = await ensureOwnedWorkspace(f.root, worker);
    const options = { dataDir: join(f.root, '.ai/cezar'), workspace: delegation.workspace, context: delegation.context };
    await placeWorkerAttachments(options);
    writeFileSync(join(workspace.path, 'qa/1149/brief.md'), 'edited by the worker');
    await placeWorkerAttachments(options);
    expect(readFileSync(join(workspace.path, 'qa/1149/brief.md'), 'utf8')).toBe('edited by the worker');
    expect(readFileSync(join(workspace.path, 'qa/evidence.log'), 'utf8')).toBe(ATTACHED['qa/evidence.log']);
  });

  it('placement refuses a path the worker baseline does not ignore, naming it', async () => {
    // Ignored only by the parent's uncommitted `.gitignore`: the worker's checkout would commit it.
    write('.gitignore', 'qa/\n');
    write('qa/evidence.log', ATTACHED['qa/evidence.log']);
    const { workerId } = await spawn(['qa/evidence.log']);
    const { worker, delegation } = workerOf(workerId);
    const workspace = await ensureOwnedWorkspace(f.root, worker);
    await expect(placeWorkerAttachments({ dataDir: join(f.root, '.ai/cezar'), workspace: delegation.workspace, context: delegation.context }))
      .rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/not ignored by the worker baseline: qa\/evidence\.log.*commit/) });
    expect(existsSync(join(workspace.path, 'qa'))).toBe(false);
  });

  it('placement refuses a symlinked directory component in the worker worktree', async () => {
    const elsewhere = join(tmpdir(), `cez-attach-elsewhere-${randomUUID()}`);
    mkdirSync(elsewhere);
    try {
      // The parent has a real `qa/` directory; the baseline tracks `qa` as a symlink out of the tree.
      commit('.gitignore', 'qa/x\n');
      symlinkSync(elsewhere, join(f.root, 'qa'));
      execFileSync('git', ['add', 'qa'], { cwd: f.root });
      execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'qa symlink'], { cwd: f.root });
      // Out of the parent's index too, or its `check-ignore` would refuse a path beyond a symlink.
      execFileSync('git', ['rm', '-q', '--cached', 'qa'], { cwd: f.root });
      rmSync(join(f.root, 'qa'));
      write('qa/x', 'attached');
      const { workerId } = await spawn(['qa/x']);
      const { worker, delegation } = workerOf(workerId);
      const workspace = await ensureOwnedWorkspace(f.root, worker);
      expect(lstatSync(join(workspace.path, 'qa')).isSymbolicLink()).toBe(true);
      await expect(placeWorkerAttachments({ dataDir: join(f.root, '.ai/cezar'), workspace: delegation.workspace, context: delegation.context }))
        .rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('qa/x') });
      expect(existsSync(join(elsewhere, 'x'))).toBe(false);
    } finally { rmSync(elsewhere, { recursive: true, force: true }); }
  });
});
