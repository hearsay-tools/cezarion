import { github, pr, acquireExternalCiResources } from './ci-wait-fixture.testkit.ts';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callSquawkWait } from '../ci-wait/client.ts';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, onTestFinished } from 'vitest';
import { WAIT_KIND, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { manager, parent, store, until, toolGenerationOf, useWorkerWaitFixture, restart } from './worker-wait-claude.testkit.ts';

describe('wait registration effects', { timeout: 30_000 }, () => {
  useWorkerWaitFixture({ acquireCiResources: acquireExternalCiResources });
  it('reports duplicate registration and refuses deadline changes without cancelling the original', async () => {
    github(); const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    const tools = manager.squawkToolHandlers(run.id, toolGenerationOf(run.id));
    const signal = new AbortController().signal;
    const request = { kind: WAIT_KIND.pr, pr, timeout_seconds: 30 };
    const first = await tools.registerWait(request, 'cezar_wait', signal);
    expect(first.answer).toMatchObject({ ok: true, effect: 'applied', deduplicated: false });
    const repeat = await tools.registerWait(request, 'cezar_wait', signal);
    expect(repeat.answer).toMatchObject({ ok: true, effect: 'unchanged', deduplicated: true, wait_id: first.answer.ok && first.answer.wait_id });
    const changed = await tools.registerWait({ ...request, timeout_seconds: 60 }, 'cezar_wait', signal);
    expect(changed.answer).toMatchObject({ ok: false, effect: 'refused', code: 'duplicate_deadline', retained_wait: { wait_id: first.answer.ok && first.answer.wait_id } });
    expect(store.getRun(run.id)?.waits?.filter(wait => wait.kind === WAIT_KIND.pr)).toMatchObject([{ id: first.answer.ok && first.answer.wait_id, phase: WAIT_PHASE.open }]);
  });

  it('recovers a durable registration when the socket closes after commit but before the answer', async () => {
    github(); const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    const tools = manager.squawkToolHandlers(run.id, toolGenerationOf(run.id));
    const directory = await mkdtemp(join(tmpdir(), 'cez-effect-'));
    const address = process.platform === 'win32' ? `\\\\.\\pipe\\cez-effect-${randomUUID()}` : join(directory, 'ipc');
    const ids: string[] = [];
    const server = createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const args = JSON.parse(Buffer.concat(chunks).toString()); ids.push(args.operation_id);
      const result = await tools.registerWait(args, 'cezar_wait', new AbortController().signal);
      if (ids.length === 1) request.socket.destroy();
      else { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result.answer)); }
    });
    onTestFinished(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(directory, { recursive: true, force: true }); });
    await new Promise<void>(done => server.listen(address, done));
    const answer = await callSquawkWait({ kind: WAIT_KIND.pr, pr, timeout_seconds: 30 }, { CEZ_TOOL_SOCKET: address, CEZ_TOOL_TOKEN: 'test-only' });
    expect(answer).toMatchObject({ ok: true, effect: 'unchanged', replayed: true });
    expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]);
    expect(store.getRun(run.id)?.waitRegistrations).toHaveLength(1);
    expect(store.getRun(run.id)?.waits?.filter(wait => wait.kind === WAIT_KIND.pr)).toHaveLength(1);
  });

  it('commits one receipt for concurrent retries of the same operation', async () => {
    github(); const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    const tools = manager.squawkToolHandlers(run.id, toolGenerationOf(run.id));
    const request = { kind: WAIT_KIND.pr, pr, timeout_seconds: 30, operation_id: randomUUID() };
    const answers = await Promise.all([tools.registerWait(request, 'cezar_wait', new AbortController().signal),
      tools.registerWait(request, 'cezar_wait', new AbortController().signal)]);
    expect(answers.map(row => row.answer.effect)).toEqual(['applied', 'unchanged']);
    expect(answers.map(row => row.answer.ok && row.answer.wait_id)).toEqual([expect.any(String), answers[0]!.answer.ok && answers[0]!.answer.wait_id]);
    expect(store.getRun(run.id)?.waitRegistrations).toHaveLength(1);
    expect(store.getRun(run.id)?.waits?.filter(wait => wait.kind === WAIT_KIND.pr)).toHaveLength(1);
  });

  it('refuses a failed commit without persisting a receipt or wait', async () => {
    github(); const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    const spy = vi.spyOn(store, 'commitWait').mockImplementation(() => { throw new Error('before commit'); });
    try {
      const result = await manager.squawkToolHandlers(run.id, toolGenerationOf(run.id)).registerWait(
        { kind: WAIT_KIND.pr, pr, timeout_seconds: 30 }, 'cezar_wait', new AbortController().signal);
      expect(result.answer).toMatchObject({ ok: false, effect: 'refused', code: 'persistence' });
      expect(store.getRun(run.id)?.waitRegistrations ?? []).toHaveLength(0);
      expect(store.getRun(run.id)?.waits?.filter(wait => wait.kind === WAIT_KIND.pr) ?? []).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });

  it('returns the durable receipt when registration throws after its commit', async () => {
    github(); const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    const commit = store.commitWait.bind(store);
    const spy = vi.spyOn(store, 'commitWait').mockImplementation((...args) => { commit(...args); throw new Error('after commit'); });
    try {
      const answer = await manager.squawkToolHandlers(run.id, toolGenerationOf(run.id)).registerWait(
        { kind: WAIT_KIND.pr, pr, timeout_seconds: 30 }, 'cezar_wait', new AbortController().signal);
      expect(answer.answer).toMatchObject({ ok: true, effect: 'applied' });
      expect(store.getRun(run.id)?.waitRegistrations).toHaveLength(1);
      expect(store.getRun(run.id)?.waits?.filter(wait => wait.kind === WAIT_KIND.pr)).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });

  it('replays committed registration after cancellation and restart without a session or a new wait', async () => {
    github(); const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    const generation = toolGenerationOf(run.id);
    const request = { kind: WAIT_KIND.pr, pr, timeout_seconds: 30, operation_id: randomUUID() };
    const first = await manager.registerWait(run.id, request, 'cezar_wait', generation);
    manager.cancelWait(run.id, first.id, generation);
    await restart();
    expect(manager.isActive(run.id)).toBe(false);
    const replay = await manager.squawkToolHandlers(run.id, 'no-session').registerWait(request, 'cezar_wait', new AbortController().signal);
    expect(replay.answer).toMatchObject({ ok: true, effect: 'unchanged', replayed: true, wait_id: first.id, wait_phase: WAIT_PHASE.cancelled });
    expect(store.getRun(run.id)?.waits?.filter(wait => wait.kind === WAIT_KIND.pr && wait.phase === WAIT_PHASE.open) ?? []).toEqual([]);
    const changed = await manager.squawkToolHandlers(run.id, 'no-session').registerWait({ ...request, timeout_seconds: 60 }, 'cezar_wait', new AbortController().signal);
    expect(changed.answer).toMatchObject({ ok: false, effect: 'refused', code: 'operation_conflict' });
  });
});
