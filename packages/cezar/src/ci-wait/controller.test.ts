import { afterEach, describe, expect, it, vi } from 'vitest';
import { stat, access, rm, mkdtemp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { cezarAskAnswerSchema, cezarCancelWaitAnswerSchema, cezarDoneAnswerSchema, cezarWaitAnswerSchema, type CezarAskAnswer, type CezarCancelWaitAnswer, type CezarDoneAnswer, type Wait } from '@open-mercato/cezar-contract/waits';
import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CiToolController, type CezarToolHandlers, type WaitRegistration } from './controller.ts';
import { callCezarAsk, callCezarCancelWait, callCezarDone, callCezarWait } from './client.ts';

/** Hang guard for the waits below: each ends the moment its condition holds, so the bound only ends a hang. */
const HANG_GUARD_MS = 15_000;

const wait = { id: '11111111-1111-4111-8111-111111111111', generation: 'generation', turnId: 'turn', timeoutSeconds: 1800, until: 'checks' as const, wakeOnConflict: true, prUrl: 'https://github.com/owner/repo/pull/1', repository: 'owner/repo', prNumber: 1, headSha: 'a'.repeat(40), registeredAt: '2026-09-22T00:00:00.000Z', deadline: '2026-09-22T00:30:00.000Z', phase: 'registered' as const };
const entry: Wait = { kind: 'pr', source: 'agent', via: 'cezar_wait', ...wait, phase: 'open' };
const openWait = { wait_id: wait.id, kind: 'pr' as const, deadline: wait.deadline, summary: 'CI for owner/repo#1' };
const registered: WaitRegistration = { answer: { ok: true, wait_id: wait.id, kind: 'pr', deadline: wait.deadline, open_waits: [openWait] }, wait: entry };
const cancelled: CezarCancelWaitAnswer = { cancelled: true, wait_id: wait.id, open_waits: [] };
const accepted: CezarDoneAnswer = { ok: true, finishes: 'at_turn_end', completes: 'task', open_waits: [openWait] };
const humanId = '22222222-2222-4222-8222-222222222222';
const asked: CezarAskAnswer = { ok: true, wait_id: humanId, open_waits: [openWait, { wait_id: humanId, kind: 'human', summary: 'human: Which area?' }] };
function handlers(overrides: Partial<CezarToolHandlers> = {}): CezarToolHandlers {
  return { registerWait: async () => registered, ask: async () => asked, cancelWait: async () => cancelled, finishTurn: async () => accepted, ...overrides };
}
const coded = (code: string) => async (): Promise<never> => { throw Object.assign(new Error('secret-sensitive'), { code }); };
const controllers: CiToolController[] = [];
afterEach(async () => { await Promise.all(controllers.splice(0).map(controller => controller.close())); });
async function controller() { const value = await CiToolController.start(); controllers.push(value); return value; }
// One connection per call, as client.ts does (hearsay-tools/cezarion#1484): the server closes a
// connection after it refuses an oversized body, and a pooled keep-alive socket then resets the next call.
function raw(env: Record<string,string>, body: string, token = env.CEZ_TOOL_TOKEN, route = 'wait') {
  return new Promise<{status:number;body:string}>((resolve, reject) => {
    const req = request({ socketPath: env.CEZ_TOOL_SOCKET, agent: false, path: `/api/v1/tools/${route}`, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode!, body }));
    }); req.on('error', reject); req.end(body);
  });
}
describe('private CI controller', () => {
  it('has a private IPC endpoint, secret-free descriptor, and removes resources on close', async () => {
    const owner = await controller(); const session = owner.provision(handlers());
    expect(JSON.stringify(session.descriptor)).not.toContain(session.env.CEZ_TOOL_TOKEN);
    if (process.platform !== 'win32') {
      expect((await stat(dirname(session.env.CEZ_TOOL_SOCKET!))).mode & 0o777).toBe(0o700);
      expect((await stat(session.env.CEZ_TOOL_SOCKET!)).mode & 0o777).toBe(0o600);
    }
    const answer = await callCezarWait({ kind: 'pr', pr: wait.prUrl }, session.env);
    expect(answer).toMatchObject({ ok: true, wait_id: wait.id });
    expect(answer).not.toHaveProperty('generation');
    expect(answer).not.toHaveProperty('turnId');
    await owner.close();
    await expect(callCezarWait({ kind: 'pr', pr: wait.prUrl }, session.env)).resolves.toMatchObject({ ok: false, code: 'unavailable' });
    if (process.platform !== 'win32') await expect(access(dirname(session.env.CEZ_TOOL_SOCKET!))).rejects.toThrow();
  });
  it('rejects unknown/invalid/oversized bodies and unknown capabilities before registration', async () => {
    const register = vi.fn(async () => registered); const session = (await controller()).provision(handlers({ registerWait: register }));
    expect((await raw(session.env, JSON.stringify({kind:'pr',pr:wait.prUrl}), 'invalid')).status).toBe(401);
    for (const body of [JSON.stringify({kind:'pr',pr:wait.prUrl,runId:'injected'}), '{', ' '.repeat(16385)]) {
      const response = await raw(session.env, body);
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ ok: false, code: 'invalid_request' });
    }
    expect(register).not.toHaveBeenCalled();
  });
  it('revokes pending registration authority and rejects late receipt', async () => {
    let complete!: () => void; let signal!: AbortSignal;
    const session = (await controller()).provision(handlers({ registerWait: async (_request, _via, active) => { signal = active; await new Promise<void>(resolve => complete = resolve); active.throwIfAborted(); return registered; } }));
    const pending = callCezarWait({ kind: 'pr', pr: wait.prUrl }, session.env);
    await vi.waitFor(() => expect(complete).toBeDefined(), { timeout: HANG_GUARD_MS });
    session.revoke(); expect(signal.aborted).toBe(true); complete();
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'unavailable' });
    await expect(callCezarWait({ kind: 'pr', pr: wait.prUrl }, session.env)).resolves.toMatchObject({ ok: false, code: 'unavailable' });
  });
  it('keeps Unix socket paths short even when the inherited temporary directory is long', async () => {
    if (process.platform === 'win32') return;
    const base = await mkdtemp(join(tmpdir(), 'long-tmp-'));
    const nested = join(base, 'x'.repeat(100)); await mkdir(nested);
    const previous = process.env.TMPDIR;
    try {
      process.env.TMPDIR = nested;
      const session = (await controller()).provision(handlers());
      expect(Buffer.byteLength(session.env.CEZ_TOOL_SOCKET!)).toBeLessThan(100);
      await expect(callCezarWait({kind:'pr',pr:wait.prUrl}, session.env)).resolves.toMatchObject({ok:true,wait_id:wait.id});
    } finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; await rm(base, {recursive:true,force:true}); }
  });

  it('preserves actionable contract error codes without forwarding thrown messages', async () => {
    const session = (await controller()).provision(handlers({ registerWait: coded('wait_conflict') }));
    const response = await raw(session.env, JSON.stringify({kind:'pr',pr:wait.prUrl}));
    expect(JSON.parse(response.body)).toEqual({ok:false,code:'wait_conflict',message:'A different CI wait is already active for this run.'});
    await expect(callCezarWait({kind:'pr',pr:wait.prUrl},session.env)).resolves.toMatchObject({ok:false,code:'wait_conflict'});
  });

  it('bounds registration errors and never returns exception secrets', async () => {
    const session = (await controller()).provision(handlers({ registerWait: async () => { throw new Error('secret-token-sensitive'); } }));
    const response = await raw(session.env, JSON.stringify({ kind: 'pr', pr: wait.prUrl }));
    expect(JSON.parse(response.body)).toMatchObject({ ok: false, code: 'unavailable' }); expect(response.body).not.toContain('secret-token-sensitive');
  });
  it('adapter exits on harness stdin EOF while its controller remains alive', async () => {
    const session = (await controller()).provision(handlers());
    const child = spawn(session.descriptor.command, session.descriptor.args, {env:session.env,stdio:['pipe','pipe','ignore']});
    try {
      const initialized = new Promise<void>(resolve => child.stdout.once('data', () => resolve()));
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'eof-test',version:'1'}}})+'\n');
      await initialized;
      child.stdin.end();
      await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: HANG_GUARD_MS });
    } finally { child.kill('SIGKILL'); }
  });

  it('hard controller death closes the connected MCP adapter without a model turn', async () => {
    const child = fork(fileURLToPath(new URL('./__fixtures__/controller-owner.mjs', import.meta.url)), [], { execArgv: ['--import', import.meta.resolve('tsx')], silent: true });
    const session = await new Promise<{ descriptor: { command: string; args: string[] }; env: Record<string,string> }>((resolve, reject) => { child.once('message', value => resolve(value as never)); child.once('error', reject); });
    const client = new Client({ name: 'owner-death-test', version: '1' });
    try {
      await client.connect(new StdioClientTransport({ ...session.descriptor, env: session.env, stderr: 'pipe' }));
      expect((await client.listTools()).tools).toHaveLength(4);
      const closed = new Promise<void>(resolve => { client.onclose = resolve; });
      child.kill('SIGKILL');
      await closed;
    } finally { child.kill('SIGKILL'); await client.close(); if (process.platform !== 'win32') await rm(dirname(session.env.CEZ_TOOL_SOCKET!), { recursive: true, force: true }); }
  }, 10000);

  it('bundled MCP negotiates, lists the wait tools without registering, and invokes real IPC', async () => {
    const register = vi.fn(async () => registered); const cancel = vi.fn(async () => cancelled);
    const session = (await controller()).provision(handlers({ registerWait: register, cancelWait: cancel }));
    const client = new Client({ name: 'ci-test', version: '1' });
    const transport = new StdioClientTransport({ ...session.descriptor, env: { ...session.env }, stderr: 'pipe' });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name)).toEqual(['cezar_wait', 'cezar_ask', 'cezar_cancel_wait', 'cezar_done']);
      for (const tool of listed.tools) expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(register).not.toHaveBeenCalled();
      // hearsay-tools/cezarion#1236: the removed alias is an unknown tool.
      const removed = await client.callTool({ name: 'cezar_wait_for_ci', arguments: { pr: wait.prUrl } });
      expect(removed.isError).toBe(true);
      const invalid = await client.callTool({ name: 'cezar_wait', arguments: { kind: 'pr', pr: wait.prUrl, runId: 'evil' } });
      expect(invalid.isError).toBe(true); expect(register).not.toHaveBeenCalled();
      const opened = await client.callTool({ name: 'cezar_wait', arguments: { kind: 'pr', pr: wait.prUrl } });
      expect(opened.isError).not.toBe(true);
      const [text] = (opened.content as Array<{ text: string }>).map(part => part.text);
      const [json, hint] = text!.split('\n');
      expect(cezarWaitAnswerSchema.parse(JSON.parse(json!))).toEqual(registered.answer);
      expect(hint).toBe('Registered. End your turn to wait; any open wait wakes you when it resolves.');
      expect(register).toHaveBeenLastCalledWith({ kind: 'pr', pr: wait.prUrl, until: 'checks', wake_on_conflict: true, timeout_seconds: 1800 }, 'cezar_wait', expect.any(AbortSignal));
      const closed = await client.callTool({ name: 'cezar_cancel_wait', arguments: { wait_id: wait.id } });
      expect(closed.isError).not.toBe(true);
      expect(cezarCancelWaitAnswerSchema.parse(JSON.parse((closed.content as Array<{ text: string }>)[0]!.text.split('\n')[0]!))).toEqual(cancelled);
      expect(cancel).toHaveBeenCalledWith({ wait_id: wait.id }, expect.any(AbortSignal));
      const refused = await client.callTool({ name: 'cezar_wait', arguments: { kind: 'timer', seconds: 59 } });
      expect(refused.isError).toBe(true); expect(register).toHaveBeenCalledTimes(1);
      const done = await client.callTool({ name: 'cezar_done', arguments: {} });
      expect(done.isError).not.toBe(true);
      const [doneJson, doneHint] = (done.content as Array<{ text: string }>)[0]!.text.split('\n');
      expect(cezarDoneAnswerSchema.parse(JSON.parse(doneJson!))).toEqual(accepted);
      expect(doneHint).toBe('Accepted. End your turn; Cezar finishes the task at its end.');
    } finally { await client.close(); }
  }, 15000);
});

// hearsay-tools/cezarion#1233: `cezar_wait` and `cezar_cancel_wait` reach the session's own handlers;
// the `cezar_wait_for_ci` route is gone (hearsay-tools/cezarion#1236).
describe('private wait routes', () => {
  it('routes POST /tools/wait and /tools/cancel-wait to the capability handlers, and POST /tools/ci-wait no longer exists', async () => {
    const register = vi.fn(async () => registered); const cancel = vi.fn(async () => cancelled);
    const session = (await controller()).provision(handlers({ registerWait: register, cancelWait: cancel }));
    const opened = await raw(session.env, JSON.stringify({ kind: 'pr', pr: wait.prUrl }), undefined, 'wait');
    expect(opened.status).toBe(200);
    expect(cezarWaitAnswerSchema.parse(JSON.parse(opened.body))).toEqual(registered.answer);
    expect(register).toHaveBeenLastCalledWith({ kind: 'pr', pr: wait.prUrl, until: 'checks', wake_on_conflict: true, timeout_seconds: 1800 }, 'cezar_wait', expect.any(AbortSignal));
    await expect(callCezarWait({ kind: 'timer', seconds: 600, note: 'deploy' }, session.env)).resolves.toEqual(registered.answer);
    expect(register).toHaveBeenLastCalledWith({ kind: 'timer', seconds: 600, note: 'deploy' }, 'cezar_wait', expect.any(AbortSignal));
    const closed = await raw(session.env, JSON.stringify({ wait_id: wait.id }), undefined, 'cancel-wait');
    expect(closed.status).toBe(200);
    expect(cezarCancelWaitAnswerSchema.parse(JSON.parse(closed.body))).toEqual(cancelled);
    expect(cancel).toHaveBeenCalledWith({ wait_id: wait.id }, expect.any(AbortSignal));
    await expect(callCezarCancelWait({ wait_id: wait.id }, session.env)).resolves.toEqual(cancelled);
    // The removed alias: the authorized POST finds no route and registers nothing.
    const calls = register.mock.calls.length;
    expect((await raw(session.env, JSON.stringify({ pr: wait.prUrl, timeout_seconds: 60 }), undefined, 'ci-wait')).status).toBe(404);
    expect(register).toHaveBeenCalledTimes(calls);
  });

  it('answers invalid_request for a timer below 60 seconds without calling the handler', async () => {
    const register = vi.fn(async () => registered); const cancel = vi.fn(async () => cancelled);
    const session = (await controller()).provision(handlers({ registerWait: register, cancelWait: cancel }));
    const below = await raw(session.env, JSON.stringify({ kind: 'timer', seconds: 59 }), undefined, 'wait');
    expect(below.status).toBe(200);
    const answer = cezarWaitAnswerSchema.parse(JSON.parse(below.body));
    expect(answer).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(answer.ok === false && answer.message).toMatch(/seconds.*60.*7200/);
    for (const body of [{ kind: 'timer', seconds: 7201 }, { kind: 'worker' }, { kind: 'pr', pr: wait.prUrl, runId: 'injected' }, { pr: wait.prUrl }]) {
      expect(await callCezarWait(body, session.env)).toMatchObject({ ok: false, code: 'invalid_request' });
    }
    expect(JSON.parse((await raw(session.env, '{', undefined, 'wait')).body)).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(JSON.parse((await raw(session.env, ' '.repeat(16385), undefined, 'wait')).body)).toMatchObject({ ok: false, code: 'invalid_request' });
    // A field of another kind is refused by name.
    const stray = await callCezarWait({ kind: 'timer', seconds: 120, worker_ids: ['11111111-1111-4111-8111-111111111111'] }, session.env);
    expect(stray).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(stray.ok === false && stray.message).toContain('"worker_ids"');
    expect(register).not.toHaveBeenCalled();
    for (const body of [{ wait_id: 'w1' }, { wait_id: wait.id, extra: 1 }, {}]) {
      expect(await callCezarCancelWait(body, session.env)).toMatchObject({ cancelled: false, code: 'invalid_request' });
    }
    expect(cancel).not.toHaveBeenCalled();
    expect((await raw(session.env, JSON.stringify({ kind: 'timer', seconds: 600 }), 'invalid', 'wait')).status).toBe(401);
    expect((await raw(session.env, JSON.stringify({ wait_id: wait.id }), 'invalid', 'cancel-wait')).status).toBe(401);
  });

  it('answers a typed refusal with a fixed message, and unavailable once the capability is revoked', async () => {
    const session = (await controller()).provision(handlers({ registerWait: coded('capacity'), cancelWait: async () => { throw new Error('secret-sensitive'); } }));
    const refused = await raw(session.env, JSON.stringify({ kind: 'pr', pr: wait.prUrl }), undefined, 'wait');
    expect(refused.status).toBe(200);
    expect(JSON.parse(refused.body)).toEqual({ ok: false, code: 'capacity', message: 'CI wait registration capacity is exhausted; retry later.' });
    const failed = await raw(session.env, JSON.stringify({ wait_id: wait.id }), undefined, 'cancel-wait');
    expect(JSON.parse(failed.body)).toMatchObject({ cancelled: false, code: 'unavailable' });
    expect(refused.body + failed.body).not.toContain('secret-sensitive');
    session.revoke();
    expect(await callCezarWait({ kind: 'timer', seconds: 600 }, session.env)).toMatchObject({ ok: false, code: 'unavailable' });
    expect(await callCezarCancelWait({ wait_id: wait.id }, session.env)).toMatchObject({ cancelled: false, code: 'unavailable' });
  });

  // hearsay-tools/cezarion#1234: `cezar_done` is the same shape of route: refusals answer 200.
  it('POST /tools/done answers the handler\'s refusal with 200 and ok false', async () => {
    const refusal: CezarDoneAnswer = { ok: false, code: 'workers_outstanding', message: 'Worker w is still running.', workers: [{ worker_id: 'w', reason: 'outstanding' }], open_waits: [] };
    const finish = vi.fn(async (): Promise<CezarDoneAnswer> => refusal);
    const session = (await controller()).provision(handlers({ finishTurn: finish }));
    const refused = await raw(session.env, JSON.stringify({}), undefined, 'done');
    expect(refused.status).toBe(200);
    expect(cezarDoneAnswerSchema.parse(JSON.parse(refused.body))).toEqual(refusal);
    expect(finish).toHaveBeenLastCalledWith({}, expect.any(AbortSignal));
    finish.mockResolvedValueOnce(accepted);
    await expect(callCezarDone({ summary: 'shipped' }, session.env)).resolves.toEqual(accepted);
    expect(finish).toHaveBeenLastCalledWith({ summary: 'shipped' }, expect.any(AbortSignal));
  });

  it('POST /tools/done answers 401 once the capability is revoked', async () => {
    let complete!: () => void;
    let entered!: () => void; const handling = new Promise<void>(resolve => entered = resolve);
    const session = (await controller()).provision(handlers({ finishTurn: async () => { await new Promise<void>(resolve => { complete = resolve; entered(); }); return accepted; } }));
    const pending = raw(session.env, JSON.stringify({}), undefined, 'done');
    await handling;
    session.revoke(); complete();
    const revoked = await pending;
    expect(revoked.status).toBe(401);
    expect(JSON.parse(revoked.body)).toMatchObject({ code: 'capability_revoked' });
    expect((await raw(session.env, JSON.stringify({}), undefined, 'done')).status).toBe(401);
    expect(await callCezarDone({}, session.env)).toMatchObject({ ok: false, code: 'unavailable' });
  });

  it('POST /tools/done answers an unknown field with invalid_request without calling the handler', async () => {
    const finish = vi.fn(async (): Promise<CezarDoneAnswer> => accepted);
    const session = (await controller()).provision(handlers({ finishTurn: finish }));
    const unknown = await raw(session.env, JSON.stringify({ force: true }), undefined, 'done');
    expect(unknown.status).toBe(200);
    expect(JSON.parse(unknown.body)).toEqual({ ok: false, code: 'invalid_request', message: 'Unknown field "force": cezar_done takes only an optional summary of at most 2000 characters.' });
    expect(await callCezarDone({ summary: 'x'.repeat(2001) }, session.env)).toEqual({ ok: false, code: 'invalid_request', message: '`summary` must be a string of at most 2000 characters.' });
    expect(JSON.parse((await raw(session.env, '{', undefined, 'done')).body)).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(JSON.parse((await raw(session.env, ' '.repeat(16385), undefined, 'done')).body)).toMatchObject({ ok: false, code: 'invalid_request' });
    expect((await raw(session.env, JSON.stringify({}), 'invalid', 'done')).status).toBe(401);
    expect(finish).not.toHaveBeenCalled();
  });

  // hearsay-tools/cezarion#1234: `cezar_ask` is the same shape of route; its card is required.
  const card = { context: '## Findings\n\n- one', questions: [{ header: 'Area', question: 'Which area?', options: [{ label: 'Parser' }, { label: 'Lexer' }] }, { header: 'Name', question: 'What should it be called?' }] };
  const askTail = 'The user never sees a rejected call. Put the draft, findings, evidence and option meanings in context, and keep each question short. cezar_ask takes context and questions: context of 1–20000 characters of Markdown, shown above the card, and 1–4 questions with unique texts, each with a header of 1–12 characters, a question of 1–400 characters, an optional id of 1–64 characters, and either 2–4 options with unique labels of 1–60 characters and descriptions of at most 280 characters, or no options for an open question.';
  it('POST /tools/ask routes the card to the ask handler and answers its refusal with 200', async () => {
    const ask = vi.fn(async (): Promise<CezarAskAnswer> => asked);
    const session = (await controller()).provision(handlers({ ask }));
    const opened = await raw(session.env, JSON.stringify(card), undefined, 'ask');
    expect(opened.status).toBe(200);
    expect(cezarAskAnswerSchema.parse(JSON.parse(opened.body))).toEqual(asked);
    expect(ask).toHaveBeenLastCalledWith(card, expect.any(AbortSignal));
    const refusal: CezarAskAnswer = { ok: false, code: 'autonomous_run', message: 'Assume and continue.', open_waits: [] };
    ask.mockResolvedValueOnce(refusal);
    await expect(callCezarAsk(card, session.env)).resolves.toEqual(refusal);
    // A throw never forwards its text.
    ask.mockImplementationOnce(coded('capacity'));
    const failed = await raw(session.env, JSON.stringify(card), undefined, 'ask');
    expect(JSON.parse(failed.body)).toEqual({ ok: false, code: 'unavailable', message: 'Cezar could not show your question now. Retry once; if it fails again, ask it in your final message.' });
    expect(failed.body).not.toContain('secret-sensitive');
    session.revoke();
    expect((await raw(session.env, JSON.stringify(card), undefined, 'ask')).status).toBe(401);
    expect(await callCezarAsk(card, session.env)).toMatchObject({ ok: false, code: 'unavailable' });
  });

  it('POST /tools/ask answers a call without a card with invalid_request, and cezar_wait points the old human kind at it', async () => {
    const ask = vi.fn(async (): Promise<CezarAskAnswer> => asked); const register = vi.fn(async () => registered);
    const session = (await controller()).provision(handlers({ ask, registerWait: register }));
    expect(await callCezarAsk({}, session.env)).toEqual({ ok: false, code: 'invalid_request', message: `\`context\` must be 1–20000 characters of Markdown; \`questions\` must be a list of 1–4 questions with unique texts. ${askTail}` });
    expect(await callCezarAsk({ context: 'c', questions: [{ header: 'Area', question: 'Which?', options: [{ label: 'Only' }] }] }, session.env)).toEqual({ ok: false, code: 'invalid_request', message: `\`questions.0.options\` must be 2–4 options with unique labels, or left out for an open question. ${askTail}` });
    expect(await callCezarAsk({ kind: 'human', ...card }, session.env)).toEqual({ ok: false, code: 'invalid_request', message: `Unknown field "kind". ${askTail}` });
    expect(JSON.parse((await raw(session.env, '{', undefined, 'ask')).body)).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(JSON.parse((await raw(session.env, ' '.repeat(262_145), undefined, 'ask')).body)).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await callCezarWait({ kind: 'human', ...card }, session.env)).toEqual({ ok: false, code: 'invalid_request', message: '`kind` must be "pr", "worker", "request", "peer", "timer" or "process" (kind "ci" was replaced by kind "pr"); ask the user with cezar_ask.' });
    expect(ask).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect((await raw(session.env, JSON.stringify(card), 'invalid', 'ask')).status).toBe(401);
  });

  // hearsay-tools/cezarion#1428: a rejection names every field's real limit and says where longer
  // context belongs. The replay is task 18e7e981: the findings sat in a 785-character question
  // under a 13-character header, the agent fixed one field per rejection, then asked about
  // findings "listed above" that it never sent as assistant text.
  it('POST /tools/ask names every failing field with its limit, and points longer context to the context field', async () => {
    const ask = vi.fn(async (): Promise<CezarAskAnswer> => asked);
    const session = (await controller()).provision(handlers({ ask }));
    const findings = 'F'.repeat(785);
    const options = [{ label: 'All' }, { label: 'None' }];
    expect(await callCezarAsk({ context: 'c', questions: [{ header: 'File friction', question: findings, options }] }, session.env)).toEqual({ ok: false, code: 'invalid_request', message: `\`questions.0.header\` must be 1–12 characters; \`questions.0.question\` must be 1–400 characters. ${askTail}` });
    expect(await callCezarAsk({ context: 'c', questions: [{ header: 'Friction', question: findings, options }] }, session.env)).toEqual({ ok: false, code: 'invalid_request', message: `\`questions.0.question\` must be 1–400 characters. ${askTail}` });
    expect(await callCezarAsk({ context: 'c', questions: [{ header: 'Area', question: 'Which?', options: [{ label: 'L'.repeat(61), description: 'D'.repeat(281) }, { label: 'B' }] }] }, session.env)).toEqual({ ok: false, code: 'invalid_request', message: `\`questions.0.options.0.label\` must be 1–60 characters; \`questions.0.options.0.description\` must be at most 280 characters. ${askTail}` });
    expect(await callCezarAsk({ context: 'c', questions: [{ header: '', question: 'Which?', id: '' }] }, session.env)).toEqual({ ok: false, code: 'invalid_request', message: `\`questions.0.id\` must be 1–64 characters; \`questions.0.header\` must be 1–12 characters. ${askTail}` });
    expect(await callCezarAsk({ context: 'c', questions: ['which?'] }, session.env)).toEqual({ ok: false, code: 'invalid_request', message: `\`questions.0\` must be an object with a header and a question. ${askTail}` });
    // Every failing field, however many: a capped list sends the agent into another rejection.
    const overlong = [0, 1, 2, 3].map(index => ({ header: `Header ${index} too long`, question: `${index}${findings}` }));
    expect(await callCezarAsk({ context: 'c', questions: overlong }, session.env)).toEqual({ ok: false, code: 'invalid_request', message: `${[0, 1, 2, 3].map(index => `\`questions.${index}.header\` must be 1–12 characters; \`questions.${index}.question\` must be 1–400 characters`).join('; ')}. ${askTail}` });
    expect(await callCezarAsk([], session.env)).toEqual({ ok: false, code: 'invalid_request', message: `The arguments must be a JSON object. ${askTail}` });
    // The message never echoes the value the agent sent.
    expect(JSON.stringify(await callCezarAsk({ context: 'c', questions: [{ header: 'File friction', question: findings }] }, session.env))).not.toContain('FFFF');
    expect(ask).not.toHaveBeenCalled();
    const short = { context: 'c', questions: [{ header: 'Friction', question: 'Which project friction findings (listed above) should I file on hearsay-tools/cezarion?', options }] };
    await expect(callCezarAsk(short, session.env)).resolves.toEqual(asked);
    expect(ask).toHaveBeenLastCalledWith(short, expect.any(AbortSignal));
  });


  // hearsay-tools/cezarion#1458: content in prose between tool calls may never reach the user, so
  // the call itself carries it. A call without it is refused by name and limit.
  it('POST /tools/ask refuses a card without context, and takes 20000 multi-byte characters of it', async () => {
    const ask = vi.fn(async (): Promise<CezarAskAnswer> => asked);
    const session = (await controller()).provision(handlers({ ask }));
    const { context: _context, ...bare } = card;
    expect(await callCezarAsk(bare, session.env)).toEqual({ ok: false, code: 'invalid_request', message: `\`context\` must be 1–20000 characters of Markdown. ${askTail}` });
    expect(await callCezarAsk({ ...card, context: '' }, session.env)).toMatchObject({ ok: false, message: expect.stringContaining('`context` must be 1–20000 characters') });
    expect(await callCezarAsk({ ...card, context: 'x'.repeat(20_001) }, session.env)).toMatchObject({ ok: false, message: expect.stringContaining('`context` must be 1–20000 characters') });
    expect(ask).not.toHaveBeenCalled();
    const long = { ...card, context: '"é\n'.repeat(6_666) + 'éé' };
    expect(long.context).toHaveLength(20_000);
    await expect(callCezarAsk(long, session.env)).resolves.toEqual(asked);
    expect(ask).toHaveBeenLastCalledWith(long, expect.any(AbortSignal));
  });

  // Review of hearsay-tools/cezarion#1458: the body limit admits the largest card the schema
  // accepts, every field at its limit in characters JSON escapes to six bytes.
  it('POST /tools/ask admits the largest schema-valid card, however its JSON is escaped', async () => {
    const ask = vi.fn(async (): Promise<CezarAskAnswer> => asked);
    const session = (await controller()).provision(handlers({ ask }));
    const esc = (n: number, tag: string) => tag + '\u0001'.repeat(n - tag.length);
    const largest = { context: esc(20_000, ''), questions: [0, 1, 2, 3].map(q => ({
      id: esc(64, `${q}`), header: esc(12, `${q}`), question: esc(400, `${q}`), multiSelect: true,
      options: [0, 1, 2, 3].map(o => ({ label: esc(60, `${o}`), description: esc(280, `${o}`) })) })) };
    expect(JSON.stringify(largest).length).toBeGreaterThan(131_072);
    await expect(callCezarAsk(largest, session.env)).resolves.toEqual(asked);
  });
});

it.each([
  ['manager_disposed', /manager.*disposed/i], ['capability_revoked', /capability.*revoked/i],
  ['run_missing', /run.*no longer exists/i], ['run_not_running', /run.*not running/i],
  ['run_stopping', /run.*stopping/i], ['session_replaced', /session.*replaced|no active session/i],
  ['session_closed', /session.*closed/i], ['run_cancelled', /run.*cancelled/i],
  ['finish_requested', /finish.*requested/i], ['generation_mismatch', /earlier session/i],
  ['worker_wait_pending', /worker wait.*[Ee]nd your turn/], ['worker_execution_stopped', /worker execution.*stopped/i],
  ['root_finish_pending', /parent.*finishing/i], ['registration_aborted', /registration.*interrupted/i],
  ['turn_changed', /turn.*changed/i], ['unauthorized', /capability.*missing|revoked/i],
] as const)('returns a safe actionable message for %s', async (code, message) => {
  const session = (await controller()).provision(handlers({ registerWait: coded(code) }));
  const response = await raw(session.env, JSON.stringify({ kind: 'pr', pr: wait.prUrl }));
  expect(response.status).toBe(200);
  const body = JSON.parse(response.body) as { ok: boolean; code: string; message: string };
  expect(body.ok).toBe(false);
  expect(body.code).toBe(code);
  expect(body.message).toMatch(message);
  expect(body.message).not.toContain('secret-sensitive');
  expect(body.message).not.toContain('authority expired');
});
