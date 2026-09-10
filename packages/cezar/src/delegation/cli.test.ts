import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWorkerCommand } from './cli.ts';
import { fixture } from './service.testkit.ts';
import { createDelegationRoutes } from './routes.ts';
import { createDelegationApp, startDelegationTransport } from './transport.ts';

describe('bundled worker CLI', () => {
  let f: ReturnType<typeof fixture>, transport: Awaited<ReturnType<typeof startDelegationTransport>>;
  let output: ReturnType<typeof vi.spyOn>, env: NodeJS.ProcessEnv;
  beforeEach(async () => {
    vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture();
    transport = await startDelegationTransport(createDelegationApp(createDelegationRoutes(f.service, f.credentials)));
    env = { CEZ_DELEGATION_URL: transport.url, CEZ_DELEGATION_TOKEN: f.token };
    output = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => { await transport?.close(); f?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const json = () => JSON.parse(String(output.mock.calls.at(-1)?.[0]));
  it('uses only provisioned transport, emits JSON, and reports incomplete operations as nonzero', async () => {
    expect(await runWorkerCommand(['spawn', '--baseline', 'parent-head', '--request-id', randomUUID(), 'work'], env)).toBe(0);
    const { workerId } = json(); expect(workerId).toBeTypeOf('string');
    expect(await runWorkerCommand(['collect', workerId], env)).toBe(0); expect(json()).toMatchObject({ workerId, partial: true });
    expect(await runWorkerCommand(['inspect', workerId], env)).toBe(0); expect(json().status).toBe('queued');
    expect(await runWorkerCommand(['steer', workerId, 'next step'], env)).toBe(0); expect(json().state).toBe('queued');
    expect(await runWorkerCommand(['wait', workerId, '--timeout-seconds', '2'], env)).toBe(1); expect(json().code).toBe('incompatible_state');
    expect(await runWorkerCommand(['diff', workerId], env)).toBe(1); expect(json().code).toBe('unavailable_diff');
    expect(await runWorkerCommand(['stop', workerId], env)).toBe(0); expect(json().state).toBe('terminated');
    expect(await runWorkerCommand(['destroy', workerId], env)).toBe(0); expect(json().state).toBe('complete');
    expect(await runWorkerCommand(['spawn', '--baseline', 'HEAD', '--request-id', randomUUID(), 'retry cleanup'], env)).toBe(0);
    const incompleteId = json().workerId;
    f.store.commitWorkerExecutionStart(incompleteId);
    vi.spyOn(f.manager, 'awaitRunTermination').mockResolvedValue(false);
    expect(await runWorkerCommand(['destroy', incompleteId], env)).toBe(1);
    expect(json()).toMatchObject({ state: 'incomplete', remaining: ['process', 'worktree', 'branch'] });
    expect(JSON.stringify(output.mock.calls)).not.toContain(f.token);
  });
  it('reads an explicit context document as UTF-8 text and rejects competing or oversize sources', async () => {
    const file = join(f.root, 'context.txt'); writeFileSync(file, 'Selected context: café');
    const args = ['spawn', '--baseline', 'parent-head', '--request-id', randomUUID(), '--backend', 'claude', '--model', 'sonnet', '--context-file', file, 'work'];
    expect(await runWorkerCommand(args, env)).toBe(0);
    expect(f.store.getRun(json().workerId)).toMatchObject({ model: 'sonnet', task: expect.stringContaining('Selected context: café') });
    expect(f.store.getRun(json().workerId)?.task).not.toContain(file);
    expect(await runWorkerCommand([...args, '--context', 'other'], env)).toBe(1); expect(json().code).toBe('invalid_input');
    writeFileSync(file, 'x'.repeat(100_001));
    expect(await runWorkerCommand(args, env)).toBe(1); expect(json().code).toBe('invalid_input');
  });
  it('sends explicit wait modes and cancels a wait by ID using the provisioned transport', async () => {
    expect(await runWorkerCommand(['spawn', '--baseline', 'parent-head', '--request-id', randomUUID(), 'work'], env)).toBe(0);
    const { workerId } = json();
    for (const mode of ['one', 'any', 'all']) {
      expect(await runWorkerCommand(['wait', workerId, '--mode', mode], env)).toBe(1);
      expect(json().code).toBe('incompatible_state');
    }
    const waitId = randomUUID(); const delegation = f.store.getRun(f.parent.id)!.delegation!;
    if (delegation.role !== 'root') throw Error('fixture');
    f.store.commitDelegation([{ id: f.parent.id, delegation: { ...delegation, permissions: ['wait'], wait: {
      id: waitId, workerIds: [workerId], phase: 'registered', deadline: new Date(Date.now() + 600_000).toISOString(), outcomes: [],
    } } }]);
    expect(await runWorkerCommand(['cancel-wait', waitId], env)).toBe(0);
    expect(json()).toMatchObject({ wait: { id: waitId, reason: 'cancelled' } });
    expect(f.store.getRun(workerId)?.status).toBe('queued');
    for (const argv of [['wait', workerId, randomUUID(), '--mode', 'one'], ['wait', workerId, '--mode', 'invalid'], ['cancel-wait'], ['cancel-wait', 'bad'], ['cancel-wait', waitId, 'extra']]) {
      expect(await runWorkerCommand(argv, env)).toBe(1); expect(json().code).toBe('invalid_input');
    }
  });
  it('parses conversation commands and validates their returned contract', async () => {
    const recipientRunId = randomUUID(), id = randomUUID(), requestId = randomUUID();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ message: { ...body, senderRunId: f.parent.id, createdAt: new Date().toISOString(), requestHash: 'a'.repeat(64), state: 'accepted', timeoutSeconds: undefined }, delivery: 'queued' }));
    });
    for (const [command, kind, extra] of [['send', 'request', ['--kind', 'request']], ['progress', 'progress', []], ['reply', 'reply', ['--request-id', requestId]], ['follow-up', 'follow-up', ['--request-id', requestId]]] as const) {
      expect(await runWorkerCommand([command, recipientRunId, 'message', '--id', id, ...extra], env), JSON.stringify(json())).toBe(0);
      expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toMatchObject({ id, recipientRunId, kind, text: 'message', timeoutSeconds: 600 });
    }
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ messages: [], outcomes: [] })));
    expect(await runWorkerCommand(['conversation', recipientRunId], env)).toBe(0);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(`${transport.url}/conversation`);
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toEqual({ recipientRunId });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ requestId, status: 'cancelled', observedAt: new Date().toISOString() })));
    expect(await runWorkerCommand(['cancel-request', requestId], env)).toBe(0);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(`${transport.url}/cancel-request`);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ secret: 'unrecognized' })));
    expect(await runWorkerCommand(['conversation', recipientRunId], env)).toBe(1);
    expect(json().code).toBe('unavailable_transport');
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'incompatible_state', error: 'test' }), { status: 409 }));
    await runWorkerCommand(['wait', '--request', requestId, '--mode', 'one'], env);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(`${transport.url}/wait`);
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toMatchObject({ requestIds: [requestId], mode: 'one' });
    for (const args of [['send', recipientRunId, 'text'], ['reply', recipientRunId, 'text', '--id', id], ['send', recipientRunId, 'text', '--id', id, '--kind', 'request', '--request-id', requestId], ['wait', recipientRunId, '--request', requestId]]) {
      expect(await runWorkerCommand(args, env)).toBe(1); expect(json().code).toBe('invalid_input');
    }
  });
  it('routes both request wait forms through the real private wait endpoint', async () => {
    const requestId = randomUUID();
    const waitRequests = vi.spyOn(f.service, 'waitRequests').mockResolvedValue({ wait: { id: randomUUID(), workerIds: [], requestIds: [requestId], phase: 'registered', deadline: new Date(Date.now() + 600_000).toISOString(), outcomes: [] }, instruction: 'End your turn' });
    for (const args of [['wait', '--request', requestId], ['wait-requests', requestId]]) {
      expect(await runWorkerCommand(args, env)).toBe(0);
      expect(json()).toMatchObject({ wait: { requestIds: [requestId] } });
    }
    expect(waitRequests).toHaveBeenCalledTimes(2);
  });
  it.each([['spawn', 'task'], ['inspect', 'bad-id'], ['wait', randomUUID(), '--timeout-seconds', '0'], ['wait', randomUUID(), '--timeout-seconds', '1801'], ['wait', randomUUID(), '--timeout-seconds', '1e2'], ['inspect', randomUUID(), '--origin', 'http://evil'], ['inspect', randomUUID(), '--token', 'override'], ['inspect', randomUUID(), '--url', 'http://evil'], ['stop', randomUUID(), 'extra'], ['stop', randomUUID(), '--baseline', 'HEAD']])('rejects invalid arguments %j', async (...argv) => {
    expect(await runWorkerCommand(argv, env)).toBe(1); expect(json().code).toBe('invalid_input');
  });
  it.each(['https://127.0.0.1:123/api/v1/delegation', 'http://example.com:123/api/v1/delegation', 'http://127.evil.example:123/api/v1/delegation', 'http://127.0.0.1:123/api/v1/delegation?token=x', 'http://user:pass@127.0.0.1:123/api/v1/delegation', 'http://127.0.0.1:123/api/v1/runs'])('rejects unprovisionable endpoint %s', async url => {
    expect(await runWorkerCommand(['inspect', randomUUID()], { ...env, CEZ_DELEGATION_URL: url })).toBe(1); expect(json().code).toBe('unavailable_transport');
  });
  it('rejects missing credentials without printing inherited secrets', async () => {
    expect(await runWorkerCommand(['inspect', randomUUID()], {})).toBe(1); expect(json().code).toBe('unavailable_transport');
  });
  it('rejects redirects and malformed/oversize responses before printing them', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockImplementation(async (_url, init) => {
      expect(init?.redirect).toBe('error'); expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw Error(`redirect ${f.token}`);
    });
    expect(await runWorkerCommand(['inspect', randomUUID()], env)).toBe(1); expect(json().code).toBe('unavailable_transport');
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ token: f.token }), { headers: { 'content-type': 'application/json' } }));
    expect(await runWorkerCommand(['inspect', randomUUID()], env)).toBe(1); expect(json().code).toBe('unavailable_transport');
    fetchMock.mockResolvedValue(new Response('x'.repeat(3_145_729)));
    expect(await runWorkerCommand(['inspect', randomUUID()], env)).toBe(1); expect(json().code).toBe('unavailable_transport');
    expect(JSON.stringify(output.mock.calls)).not.toContain(f.token);
  });
});
