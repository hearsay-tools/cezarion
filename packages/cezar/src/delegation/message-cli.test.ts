import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSubcommand } from '../subcommands.ts';
import { runWorkerCommand } from './cli.ts';
import { fixture } from './service.testkit.ts';
import { createDelegationRoutes } from './routes.ts';
import { createDelegationApp, startDelegationTransport } from './transport.ts';
import { encodeConversationCursor } from '@open-mercato/cezar-contract/conversations';
import { provisionDelegationSession } from './provision.ts';

describe('task message command family', () => {
  let f: ReturnType<typeof fixture>;
  let transport: Awaited<ReturnType<typeof startDelegationTransport>>;
  let env: NodeJS.ProcessEnv;
  let output: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    vi.stubEnv('CEZ_DELEGATION', '1');
    f = fixture();
    transport = await startDelegationTransport(createDelegationApp(createDelegationRoutes(f.service, f.credentials)));
    env = { CEZ_DELEGATION_URL: transport.url, CEZ_DELEGATION_TOKEN: f.token };
    output = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => { await transport.close(); await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const json = () => JSON.parse(String(output.mock.calls.at(-1)?.[0]));
  const message = (args: string[], session = env) => runSubcommand(['message', ...args], session);
  const peer = () => f.store.createRun({ title: 'peer', task: 'peer', workflow: 'quick-task', runner: 'codex', steps: [] });

  it.each(['request', 'progress', 'follow-up', 'reply', 'conversation', 'inbox', 'cancel-request', 'wait', 'cancel-wait', 'tasks'])(
    'provides %s help without transport', async verb => {
      expect(await message([verb, '--help'], {})).toBe(0);
      expect(output.mock.calls.at(-1)?.[0]).toContain(`cez message ${verb}`);
    },
  );
  it.each(['send', 'progress', 'follow-up', 'reply', 'conversation', 'inbox', 'cancel-request', 'wait-requests'])(
    'rejects removed worker %s with exit 64 before transport', async verb => {
      const fetch = vi.spyOn(globalThis, 'fetch');
      expect(await runWorkerCommand([verb], {})).toBe(64);
      expect(json().error).toContain('cez message');
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it('rejects worker send without kind instead of reporting a null delivery', async () => {
    expect(await runWorkerCommand(['send', randomUUID(), 'instruction', '--id', randomUUID()], env)).toBe(64);
    expect(json()).toEqual({ code: 'invalid_input', error: 'Use cez message request; cez worker send was removed.' });
  });
  it('rejects request resume and worker request waits with concrete replacements', async () => {
    expect(await message(['request', randomUUID(), 'resume', '--id', randomUUID(), '--resume'])).toBe(64);
    expect(json().error).toContain('cez worker resume');
    expect(await runWorkerCommand(['wait', '--request='+randomUUID()], {})).toBe(64);
    expect(json().error).toContain('cez message wait --request');
  });
  it.each(['request', 'progress'] as const)('delivers %s with a fixed kind and prints the receipt', async kind => {
    const target = peer();
    const id = randomUUID();
    expect(await message([kind, target.id, 'hello', '--id', id])).toBe(0);
    expect(json()).toMatchObject({ message: { id, kind, recipientRunId: target.id }, delivery: 'queued' });
  });
  it('keeps text after -- literal and never treats it as help', async () => {
    const target = peer();
    expect(await message(['request', '--id', randomUUID(), '--', target.id, '--help'])).toBe(0);
    expect(json().message).toMatchObject({ text: '--help', kind: 'request' });
  });
  it('passes conversation before cursors through the HTTP boundary', async () => {
    const target = peer();
    const before = encodeConversationCursor({ createdAt: new Date().toISOString(), id: randomUUID() });
    const conversation = vi.spyOn(f.service, 'conversation').mockResolvedValue({ messages: [], outcomes: [] });
    expect(await message(['conversation', target.id, '--before', before])).toBe(0);
    expect(conversation).toHaveBeenCalledWith(expect.anything(), { recipientRunId: target.id, before });
    expect(await message(['conversation', target.id, '--before', 'bad-cursor'])).toBe(1);
    expect(json().code).toBe('invalid_input');
  });
  it('pages peer discovery, hides caller, workers and archives, and reports shared attention', async () => {
    const workers = await f.service.spawn(f.caller, { task: 'worker', baseline: 'parent-head', requestId: randomUUID() });
    const archived = peer(); f.store.updateRun(archived.id, { archived: true });
    const review = peer(); f.store.updateRun(review.id, { status: RUN_STATUS.review });
    for (let index = 0; index < 32; index++) peer();
    expect(await message(['tasks'])).toBe(0);
    expect(json().tasks).toHaveLength(32); expect(json().nextOffset).toBe(32);
    expect(json().tasks.map((task: { id: string }) => task.id)).not.toContain(f.parent.id);
    expect(json().tasks.map((task: { id: string }) => task.id)).not.toContain(workers.workerId);
    expect(await message(['tasks', '--offset', '32'])).toBe(0);
    expect(json().tasks).toEqual([expect.objectContaining({ id: review.id, status: RUN_STATUS.review, attention: 'waiting', attentionLabel: 'needs review', accepts: false, reason: 'review: only its human can continue it' })]);
    expect(await message(['tasks', '--all', '--offset', '32'])).toBe(0);
    expect(json().tasks.map((task: { id: string }) => task.id)).toContain(archived.id);
    expect(await message(['tasks', '--offset', '-1'])).toBe(1);
    expect(await message(['tasks', '--offset', '9007199254740992'])).toBe(1);
  });
  it('denies discovery to a worker', async () => {
    const { workerId } = await f.service.spawn(f.caller, { task: 'worker', baseline: 'parent-head', requestId: randomUUID() });
    const token = f.credentials.issue('project', workerId, randomUUID());
    expect(await message(['tasks'], { ...env, CEZ_DELEGATION_TOKEN: token })).toBe(1);
    expect(json().code).toBe('denied_scope');
  });
  it('teaches messages only through the message family and worker resume separately', () => {
    const session = provisionDelegationSession({ projectId: 'project', runId: f.parent.id, store: f.store, credentials: f.credentials, url: transport.url })!;
    expect(session.instructions).toContain('message request');
    expect(session.instructions).toContain('message tasks');
    expect(session.instructions).toContain('worker resume');
    expect(session.instructions).not.toMatch(/worker (?:send|reply|progress|follow-up|conversation|inbox|wait --request)\b/);
    expect(session.instructions).not.toContain('--kind');
  });
});
