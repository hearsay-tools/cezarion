import { productName } from '../home/display.ts';
import { WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stat, access, rm, mkdtemp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { squawkAskAnswerSchema, squawkCancelWaitAnswerSchema, squawkDoneAnswerSchema, squawkWaitAnswerSchema, type SquawkAskAnswer, type SquawkCancelWaitAnswer, type SquawkDoneAnswer, type Wait } from '@open-mercato/cezar-contract/waits';
import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CiToolController, type SquawkToolHandlers, type WaitRegistration } from './controller.ts';
import { callSquawkAsk, callSquawkCancelWait, callSquawkDone, callSquawkWait } from './client.ts';

const OBSOLETE_HUMAN_WAIT_KIND = 'human';

/** Hang guard for the waits below: each ends the moment its condition holds, so the bound only ends a hang. */
const HANG_GUARD_MS = 15_000;

const wait = { id: '11111111-1111-4111-8111-111111111111', generation: 'generation', turnId: 'turn', timeoutSeconds: 1800, until: 'checks' as const, wakeOnConflict: true, prUrl: 'https://github.com/owner/repo/pull/1', repository: 'owner/repo', prNumber: 1, headSha: 'a'.repeat(40), registeredAt: '2026-09-22T00:00:00.000Z', deadline: '2026-09-22T00:30:00.000Z', phase: 'registered' as const };
const entry: Wait = { kind: WAIT_KIND.pr, source: WAIT_SOURCE.agent, via: WAIT_VIA.cezar_wait, ...wait, phase: WAIT_PHASE.open };
const openWait = { wait_id: wait.id, kind: WAIT_KIND.pr, deadline: wait.deadline, summary: 'CI for owner/repo#1' };
const registered: WaitRegistration = { answer: { ok: true, wait_id: wait.id, kind: WAIT_KIND.pr, deadline: wait.deadline, open_waits: [openWait] }, wait: entry };
const cancelled: SquawkCancelWaitAnswer = { cancelled: true, wait_id: wait.id, open_waits: [] };
const accepted: SquawkDoneAnswer = { ok: true, finishes: 'at_turn_end', completes: 'task', open_waits: [openWait] };
const humanId = '22222222-2222-4222-8222-222222222222';
const asked: SquawkAskAnswer = { ok: true, wait_id: humanId, open_waits: [openWait, { wait_id: humanId, kind: WAIT_KIND.human, summary: 'human: Which area?' }] };
function handlers(overrides: Partial<SquawkToolHandlers> = {}): SquawkToolHandlers {
  return { registerWait: async () => registered, ask: async () => asked, cancelWait: async () => cancelled, finishTurn: async () => accepted, ...overrides };
}
const coded = (code: string) => async (): Promise<never> => { throw Object.assign(new Error('secret-sensitive'), { code }); };
const controllers: CiToolController[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(controllers.splice(0).map(controller => controller.close())); });
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
  it.each([undefined, '0', '1'])('passes an explicit automation state to its MCP adapter: %j', async (value) => {
    vi.stubEnv('CEZ_AUTOMATIONS', value);
    const session = (await controller()).provision(handlers());
    expect(session.env.CEZ_AUTOMATIONS).toBe(value === '0' ? '0' : '1');
    const client = new Client({ name: 'automation-state-test', version: '1' });
    try {
      await client.connect(new StdioClientTransport({ ...session.descriptor, env: session.env, stderr: 'pipe' }));
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names.includes('cezar_schedule_task')).toBe(value !== '0');
      expect(names.includes('cezar_scheduled_tasks')).toBe(value !== '0');
    } finally { await client.close(); }
  });

  it('has a private IPC endpoint, secret-free descriptor, and removes resources on close', async () => {
    const owner = await controller(); const session = owner.provision(handlers());
    expect(JSON.stringify(session.descriptor)).not.toContain(session.env.CEZ_TOOL_TOKEN);
    if (process.platform !== 'win32') {
      expect((await stat(dirname(session.env.CEZ_TOOL_SOCKET!))).mode & 0o777).toBe(0o700);
      expect((await stat(session.env.CEZ_TOOL_SOCKET!)).mode & 0o777).toBe(0o600);
    }
    const answer = await callSquawkWait({ kind: WAIT_KIND.pr, pr: wait.prUrl }, session.env);
    expect(answer).toMatchObject({ ok: true, wait_id: wait.id });
    expect(answer).not.toHaveProperty('generation');
    expect(answer).not.toHaveProperty('turnId');
    await owner.close();
    await expect(callSquawkWait({ kind: WAIT_KIND.pr, pr: wait.prUrl }, session.env)).resolves.toMatchObject({ ok: false, code: 'outcome_unknown' });
    if (process.platform !== 'win32') await expect(access(dirname(session.env.CEZ_TOOL_SOCKET!))).rejects.toThrow();
  });
  it('rejects unknown/invalid/oversized bodies and unknown capabilities before registration', async () => {
    const register = vi.fn(async () => registered); const session = (await controller()).provision(handlers({ registerWait: register }));
    expect((await raw(session.env, JSON.stringify({kind: WAIT_KIND.pr,pr:wait.prUrl}), 'invalid')).status).toBe(401);
    for (const body of [JSON.stringify({kind: WAIT_KIND.pr,pr:wait.prUrl,runId:'injected'}), '{', ' '.repeat(16385)]) {
      const response = await raw(session.env, body);
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ ok: false, code: 'invalid_request' });
    }
    expect(register).not.toHaveBeenCalled();
  });
  it('revokes pending registration authority and rejects late receipt', async () => {
    let complete!: () => void; let signal!: AbortSignal;
    const session = (await controller()).provision(handlers({ registerWait: async (_request, _via, active) => { signal = active; await new Promise<void>(resolve => complete = resolve); active.throwIfAborted(); return registered; } }));
    const pending = callSquawkWait({ kind: WAIT_KIND.pr, pr: wait.prUrl }, session.env);
    await vi.waitFor(() => expect(complete).toBeDefined(), { timeout: HANG_GUARD_MS });
    session.revoke(); expect(signal.aborted).toBe(true); complete();
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'outcome_unknown' });
    await expect(callSquawkWait({ kind: WAIT_KIND.pr, pr: wait.prUrl }, session.env)).resolves.toMatchObject({ ok: false, code: 'outcome_unknown' });
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
      await expect(callSquawkWait({kind: WAIT_KIND.pr,pr:wait.prUrl}, session.env)).resolves.toMatchObject({ok:true,wait_id:wait.id});
    } finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; await rm(base, {recursive:true,force:true}); }
  });

  it('preserves actionable contract error codes without forwarding thrown messages', async () => {
    const session = (await controller()).provision(handlers({ registerWait: coded('wait_conflict') }));
    const response = await raw(session.env, JSON.stringify({kind: WAIT_KIND.pr,pr:wait.prUrl}));
    expect(JSON.parse(response.body)).toEqual({ok:false,effect:'refused',code:'wait_conflict',message:'A different CI wait is already active for this run.'});
    await expect(callSquawkWait({kind: WAIT_KIND.pr,pr:wait.prUrl},session.env)).resolves.toMatchObject({ok:false,code:'wait_conflict'});
  });

  it('bounds registration errors and never returns exception secrets', async () => {
    const session = (await controller()).provision(handlers({ registerWait: async () => { throw new Error('secret-token-sensitive'); } }));
    const response = await raw(session.env, JSON.stringify({ kind: WAIT_KIND.pr, pr: wait.prUrl }));
    expect(JSON.parse(response.body)).toMatchObject({ ok: false, effect: 'unknown', code: 'outcome_unknown' }); expect(response.body).not.toContain('secret-token-sensitive');
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
      expect((await client.listTools()).tools).toHaveLength(6);
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
      expect(listed.tools.map(tool => tool.name)).toEqual(['cezar_wait', 'cezar_ask', 'cezar_cancel_wait', 'cezar_done', 'cezar_schedule_task', 'cezar_scheduled_tasks']);
      for (const tool of listed.tools) expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(register).not.toHaveBeenCalled();
      const invalid = await client.callTool({ name: 'cezar_wait', arguments: { kind: WAIT_KIND.pr, pr: wait.prUrl, runId: 'evil' } });
      expect(invalid.isError).toBe(true); expect(register).not.toHaveBeenCalled();
      const opened = await client.callTool({ name: 'cezar_wait', arguments: { kind: WAIT_KIND.pr, pr: wait.prUrl } });
      expect(opened.isError).not.toBe(true);
      const [text] = (opened.content as Array<{ text: string }>).map(part => part.text);
      const [json, hint] = text!.split('\n');
      expect(squawkWaitAnswerSchema.parse(JSON.parse(json!))).toEqual(registered.answer);
      expect(hint).toBe('Registered. End your turn to wait; any open wait wakes you when it resolves.');
      expect(register).toHaveBeenLastCalledWith({ kind: WAIT_KIND.pr, pr: wait.prUrl, until: 'checks', wake_on_conflict: true, timeout_seconds: 1800, operation_id: expect.any(String) }, 'cezar_wait', expect.any(AbortSignal));
      const closed = await client.callTool({ name: 'cezar_cancel_wait', arguments: { wait_id: wait.id } });
      expect(closed.isError).not.toBe(true);
      expect(squawkCancelWaitAnswerSchema.parse(JSON.parse((closed.content as Array<{ text: string }>)[0]!.text.split('\n')[0]!))).toEqual(cancelled);
      expect(cancel).toHaveBeenCalledWith({ wait_id: wait.id }, expect.any(AbortSignal));
      const refused = await client.callTool({ name: 'cezar_wait', arguments: { kind: WAIT_KIND.timer, seconds: 59 } });
      expect(refused.isError).toBe(true); expect(register).toHaveBeenCalledTimes(1);
      const done = await client.callTool({ name: 'cezar_done', arguments: {} });
      expect(done.isError).not.toBe(true);
      const [doneJson, doneHint] = (done.content as Array<{ text: string }>)[0]!.text.split('\n');
      expect(squawkDoneAnswerSchema.parse(JSON.parse(doneJson!))).toEqual(accepted);
      expect(doneHint).toBe(`Accepted. End your turn; ${productName('Cezar')} finishes the task at its end.`);
    } finally { await client.close(); }
  }, 15000);
});

// hearsay-tools/cezarion#1233: `cezar_wait` and `cezar_cancel_wait` reach the session's own handlers.
describe('private wait routes', () => {
  it('routes POST /tools/wait and /tools/cancel-wait to the capability handlers', async () => {
    const register = vi.fn(async () => registered); const cancel = vi.fn(async () => cancelled);
    const session = (await controller()).provision(handlers({ registerWait: register, cancelWait: cancel }));
    const opened = await raw(session.env, JSON.stringify({ kind: WAIT_KIND.pr, pr: wait.prUrl }), undefined, 'wait');
    expect(opened.status).toBe(200);
    expect(squawkWaitAnswerSchema.parse(JSON.parse(opened.body))).toEqual(registered.answer);
    expect(register).toHaveBeenLastCalledWith({ kind: WAIT_KIND.pr, pr: wait.prUrl, until: 'checks', wake_on_conflict: true, timeout_seconds: 1800 }, 'cezar_wait', expect.any(AbortSignal));
    await expect(callSquawkWait({ kind: WAIT_KIND.timer, seconds: 600, note: 'deploy' }, session.env)).resolves.toEqual(registered.answer);
    expect(register).toHaveBeenLastCalledWith({ kind: WAIT_KIND.timer, seconds: 600, note: 'deploy', operation_id: expect.any(String) }, 'cezar_wait', expect.any(AbortSignal));
    const closed = await raw(session.env, JSON.stringify({ wait_id: wait.id }), undefined, 'cancel-wait');
    expect(closed.status).toBe(200);
    expect(squawkCancelWaitAnswerSchema.parse(JSON.parse(closed.body))).toEqual(cancelled);
    expect(cancel).toHaveBeenCalledWith({ wait_id: wait.id }, expect.any(AbortSignal));
    await expect(callSquawkCancelWait({ wait_id: wait.id }, session.env)).resolves.toEqual(cancelled);
  });

  it('answers invalid_request for a timer below 60 seconds without calling the handler', async () => {
    const register = vi.fn(async () => registered); const cancel = vi.fn(async () => cancelled);
    const session = (await controller()).provision(handlers({ registerWait: register, cancelWait: cancel }));
    const below = await raw(session.env, JSON.stringify({ kind: WAIT_KIND.timer, seconds: 59 }), undefined, 'wait');
    expect(below.status).toBe(200);
    const answer = squawkWaitAnswerSchema.parse(JSON.parse(below.body));
    expect(answer).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(answer.ok === false && answer.message).toMatch(/seconds.*60.*7200/);
    for (const body of [{ kind: WAIT_KIND.timer, seconds: 7201 }, { kind: WAIT_KIND.worker }, { kind: WAIT_KIND.pr, pr: wait.prUrl, runId: 'injected' }, { pr: wait.prUrl }]) {
      expect(await callSquawkWait(body, session.env)).toMatchObject({ ok: false, code: 'invalid_request' });
    }
    expect(JSON.parse((await raw(session.env, '{', undefined, 'wait')).body)).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(JSON.parse((await raw(session.env, ' '.repeat(16385), undefined, 'wait')).body)).toMatchObject({ ok: false, code: 'invalid_request' });
    // A field of another kind is refused by name.
    const stray = await callSquawkWait({ kind: WAIT_KIND.timer, seconds: 120, worker_ids: ['11111111-1111-4111-8111-111111111111'] }, session.env);
    expect(stray).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(stray.ok === false && stray.message).toContain('"worker_ids"');
    expect(register).not.toHaveBeenCalled();
    for (const body of [{ wait_id: 'w1' }, { wait_id: wait.id, extra: 1 }, {}]) {
      expect(await callSquawkCancelWait(body, session.env)).toMatchObject({ cancelled: false, code: 'invalid_request' });
    }
    expect(cancel).not.toHaveBeenCalled();
    expect((await raw(session.env, JSON.stringify({ kind: WAIT_KIND.timer, seconds: 600 }), 'invalid', 'wait')).status).toBe(401);
    expect((await raw(session.env, JSON.stringify({ wait_id: wait.id }), 'invalid', 'cancel-wait')).status).toBe(401);
  });

  it('answers a typed refusal with a fixed message, and unavailable once the capability is revoked', async () => {
    const session = (await controller()).provision(handlers({ registerWait: coded('capacity'), cancelWait: async () => { throw new Error('secret-sensitive'); } }));
    const refused = await raw(session.env, JSON.stringify({ kind: WAIT_KIND.pr, pr: wait.prUrl }), undefined, 'wait');
    expect(refused.status).toBe(200);
    expect(JSON.parse(refused.body)).toEqual({ ok: false, effect: 'refused', code: 'capacity', message: 'CI wait registration capacity is exhausted; retry later.' });
    const failed = await raw(session.env, JSON.stringify({ wait_id: wait.id }), undefined, 'cancel-wait');
    expect(JSON.parse(failed.body)).toMatchObject({ cancelled: false, code: 'unavailable' });
    expect(refused.body + failed.body).not.toContain('secret-sensitive');
    session.revoke();
    expect(await callSquawkWait({ kind: WAIT_KIND.timer, seconds: 600 }, session.env)).toMatchObject({ ok: false, code: 'outcome_unknown' });
    expect(await callSquawkCancelWait({ wait_id: wait.id }, session.env)).toMatchObject({ cancelled: false, code: 'unavailable' });
  });

  // hearsay-tools/cezarion#1234: `cezar_done` is the same shape of route: refusals answer 200.
  it('POST /tools/done answers the handler\'s refusal with 200 and ok false', async () => {
    const refusal: SquawkDoneAnswer = { ok: false, code: 'workers_outstanding', message: 'Worker w is still running.', workers: [{ worker_id: 'w', reason: 'outstanding' }], open_waits: [] };
    const finish = vi.fn(async (): Promise<SquawkDoneAnswer> => refusal);
    const session = (await controller()).provision(handlers({ finishTurn: finish }));
    const refused = await raw(session.env, JSON.stringify({}), undefined, 'done');
    expect(refused.status).toBe(200);
    expect(squawkDoneAnswerSchema.parse(JSON.parse(refused.body))).toEqual(refusal);
    expect(finish).toHaveBeenLastCalledWith({}, expect.any(AbortSignal));
    finish.mockResolvedValueOnce(accepted);
    await expect(callSquawkDone({ summary: 'shipped' }, session.env)).resolves.toEqual(accepted);
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
    expect(await callSquawkDone({}, session.env)).toMatchObject({ ok: false, code: 'unavailable' });
  });

  it('POST /tools/done answers an unknown field with invalid_request without calling the handler', async () => {
    const finish = vi.fn(async (): Promise<SquawkDoneAnswer> => accepted);
    const session = (await controller()).provision(handlers({ finishTurn: finish }));
    const unknown = await raw(session.env, JSON.stringify({ force: true }), undefined, 'done');
    expect(unknown.status).toBe(200);
    expect(JSON.parse(unknown.body)).toEqual({ ok: false, code: 'invalid_request', message: 'Unknown field "force": cezar_done takes only an optional summary of at most 2000 characters.' });
    expect(await callSquawkDone({ summary: 'x'.repeat(2001) }, session.env)).toEqual({ ok: false, code: 'invalid_request', message: '`summary` must be a string of at most 2000 characters.' });
    expect(JSON.parse((await raw(session.env, '{', undefined, 'done')).body)).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(JSON.parse((await raw(session.env, ' '.repeat(16385), undefined, 'done')).body)).toMatchObject({ ok: false, code: 'invalid_request' });
    expect((await raw(session.env, JSON.stringify({}), 'invalid', 'done')).status).toBe(401);
    expect(finish).not.toHaveBeenCalled();
  });

  // hearsay-tools/cezarion#1234: `cezar_ask` is the same shape of route; its card is required.
  const card = { context: '## Findings\n\n- one', questions: [{ header: 'Area', question: 'Which area?', options: [{ label: 'Parser' }, { label: 'Lexer' }] }, { header: 'Name', question: 'What should it be called?' }] };
  const askTail = 'The user never sees a rejected call. Put the draft, findings, evidence and option meanings in context, and keep each question short. cezar_ask takes context and questions: context of 1–20000 characters of Markdown, shown above the card, and 1–4 questions with unique texts, each with a header of 1–12 characters, a question of 1–400 characters, an optional id of 1–64 characters, and either 2–4 options with unique labels of 1–60 characters and descriptions of at most 280 characters, or no options for an open question.';
  it('POST /tools/ask routes the card to the ask handler and answers its refusal with 200', async () => {
    const ask = vi.fn(async (): Promise<SquawkAskAnswer> => asked);
    const session = (await controller()).provision(handlers({ ask }));
    const opened = await raw(session.env, JSON.stringify(card), undefined, 'ask');
    expect(opened.status).toBe(200);
    expect(squawkAskAnswerSchema.parse(JSON.parse(opened.body))).toEqual(asked);
    expect(ask).toHaveBeenLastCalledWith(card, expect.any(AbortSignal));
    const refusal: SquawkAskAnswer = { ok: false, code: 'autonomous_run', message: 'Assume and continue.', open_waits: [] };
    ask.mockResolvedValueOnce(refusal);
    await expect(callSquawkAsk(card, session.env)).resolves.toEqual(refusal);
    // A throw never forwards its text.
    ask.mockImplementationOnce(coded('capacity'));
    const failed = await raw(session.env, JSON.stringify(card), undefined, 'ask');
    expect(JSON.parse(failed.body)).toEqual({ ok: false, code: 'unavailable', message: `${productName('Cezar')} could not show your question now. Retry once; if it fails again, ask it in your final message.` });
    expect(failed.body).not.toContain('secret-sensitive');
    session.revoke();
    expect((await raw(session.env, JSON.stringify(card), undefined, 'ask')).status).toBe(401);
    expect(await callSquawkAsk(card, session.env)).toMatchObject({ ok: false, code: 'unavailable' });
  });

  it('POST /tools/ask answers a call without a card with invalid_request', async () => {
    const ask = vi.fn(async (): Promise<SquawkAskAnswer> => asked);
    const session = (await controller()).provision(handlers({ ask }));
    expect(await callSquawkAsk({}, session.env)).toEqual({ ok: false, code: 'invalid_request', message: `\`context\` must be 1–20000 characters of Markdown; \`questions\` must be a list of 1–4 questions with unique texts. ${askTail}` });
    expect(await callSquawkAsk({ context: 'c', questions: [{ header: 'Area', question: 'Which?', options: [{ label: 'Only' }] }] }, session.env)).toEqual({ ok: false, code: 'invalid_request', message: `\`questions.0.options\` must be 2–4 options with unique labels, or left out for an open question. ${askTail}` });
    expect(await callSquawkAsk({ kind: OBSOLETE_HUMAN_WAIT_KIND, ...card }, session.env)).toEqual({ ok: false, code: 'invalid_request', message: `Unknown field "kind". ${askTail}` });
    expect(JSON.parse((await raw(session.env, '{', undefined, 'ask')).body)).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(JSON.parse((await raw(session.env, ' '.repeat(262_145), undefined, 'ask')).body)).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(ask).not.toHaveBeenCalled();
    expect((await raw(session.env, JSON.stringify(card), 'invalid', 'ask')).status).toBe(401);
  });

  // hearsay-tools/cezarion#1428: a rejection names every field's real limit and says where longer
  // context belongs. The replay is task 18e7e981: the findings sat in a 785-character question
  // under a 13-character header, the agent fixed one field per rejection, then asked about
  // findings "listed above" that it never sent as assistant text.
  it('POST /tools/ask names every failing field with its limit, and points longer context to the context field', async () => {
    const ask = vi.fn(async (): Promise<SquawkAskAnswer> => asked);
    const session = (await controller()).provision(handlers({ ask }));
    const findings = 'F'.repeat(785);
    const options = [{ label: 'All' }, { label: 'None' }];
    expect(await callSquawkAsk({ context: 'c', questions: [{ header: 'File friction', question: findings, options }] }, session.env)).toEqual({ ok: false, code: 'invalid_request', message: `\`questions.0.header\` must be 1–12 characters; \`questions.0.question\` must be 1–400 characters. ${askTail}` });
    expect(await callSquawkAsk({ context: 'c', questions: [{ header: 'Friction', question: findings, options }] }, session.env)).toEqual({ ok: false, code: 'invalid_request', message: `\`questions.0.question\` must be 1–400 characters. ${askTail}` });
    expect(await callSquawkAsk({ context: 'c', questions: [{ header: 'Area', question: 'Which?', options: [{ label: 'L'.repeat(61), description: 'D'.repeat(281) }, { label: 'B' }] }] }, session.env)).toEqual({ ok: false, code: 'invalid_request', message: `\`questions.0.options.0.label\` must be 1–60 characters; \`questions.0.options.0.description\` must be at most 280 characters. ${askTail}` });
    expect(await callSquawkAsk({ context: 'c', questions: [{ header: '', question: 'Which?', id: '' }] }, session.env)).toEqual({ ok: false, code: 'invalid_request', message: `\`questions.0.id\` must be 1–64 characters; \`questions.0.header\` must be 1–12 characters. ${askTail}` });
    expect(await callSquawkAsk({ context: 'c', questions: ['which?'] }, session.env)).toEqual({ ok: false, code: 'invalid_request', message: `\`questions.0\` must be an object with a header and a question. ${askTail}` });
    // Every failing field, however many: a capped list sends the agent into another rejection.
    const overlong = [0, 1, 2, 3].map(index => ({ header: `Header ${index} too long`, question: `${index}${findings}` }));
    expect(await callSquawkAsk({ context: 'c', questions: overlong }, session.env)).toEqual({ ok: false, code: 'invalid_request', message: `${[0, 1, 2, 3].map(index => `\`questions.${index}.header\` must be 1–12 characters; \`questions.${index}.question\` must be 1–400 characters`).join('; ')}. ${askTail}` });
    expect(await callSquawkAsk([], session.env)).toEqual({ ok: false, code: 'invalid_request', message: `The arguments must be a JSON object. ${askTail}` });
    // The message never echoes the value the agent sent.
    expect(JSON.stringify(await callSquawkAsk({ context: 'c', questions: [{ header: 'File friction', question: findings }] }, session.env))).not.toContain('FFFF');
    expect(ask).not.toHaveBeenCalled();
    const short = { context: 'c', questions: [{ header: 'Friction', question: 'Which project friction findings (listed above) should I file on hearsay-tools/cezarion?', options }] };
    await expect(callSquawkAsk(short, session.env)).resolves.toEqual(asked);
    expect(ask).toHaveBeenLastCalledWith(short, expect.any(AbortSignal));
  });


  // hearsay-tools/cezarion#1458: content in prose between tool calls may never reach the user, so
  // the call itself carries it. A call without it is refused by name and limit.
  it('POST /tools/ask refuses a card without context, and takes 20000 multi-byte characters of it', async () => {
    const ask = vi.fn(async (): Promise<SquawkAskAnswer> => asked);
    const session = (await controller()).provision(handlers({ ask }));
    const { context: _context, ...bare } = card;
    expect(await callSquawkAsk(bare, session.env)).toEqual({ ok: false, code: 'invalid_request', message: `\`context\` must be 1–20000 characters of Markdown. ${askTail}` });
    expect(await callSquawkAsk({ ...card, context: '' }, session.env)).toMatchObject({ ok: false, message: expect.stringContaining('`context` must be 1–20000 characters') });
    expect(await callSquawkAsk({ ...card, context: 'x'.repeat(20_001) }, session.env)).toMatchObject({ ok: false, message: expect.stringContaining('`context` must be 1–20000 characters') });
    expect(ask).not.toHaveBeenCalled();
    const long = { ...card, context: '"é\n'.repeat(6_666) + 'éé' };
    expect(long.context).toHaveLength(20_000);
    await expect(callSquawkAsk(long, session.env)).resolves.toEqual(asked);
    expect(ask).toHaveBeenLastCalledWith(long, expect.any(AbortSignal));
  });

  // Review of hearsay-tools/cezarion#1458: the body limit admits the largest card the schema
  // accepts, every field at its limit in characters JSON escapes to six bytes.
  it('POST /tools/ask admits the largest schema-valid card, however its JSON is escaped', async () => {
    const ask = vi.fn(async (): Promise<SquawkAskAnswer> => asked);
    const session = (await controller()).provision(handlers({ ask }));
    const esc = (n: number, tag: string) => tag + '\u0001'.repeat(n - tag.length);
    const largest = { context: esc(20_000, ''), questions: [0, 1, 2, 3].map(q => ({
      id: esc(64, `${q}`), header: esc(12, `${q}`), question: esc(400, `${q}`), multiSelect: true,
      options: [0, 1, 2, 3].map(o => ({ label: esc(60, `${o}`), description: esc(280, `${o}`) })) })) };
    expect(JSON.stringify(largest).length).toBeGreaterThan(131_072);
    await expect(callSquawkAsk(largest, session.env)).resolves.toEqual(asked);
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
  const response = await raw(session.env, JSON.stringify({ kind: WAIT_KIND.pr, pr: wait.prUrl }));
  expect(response.status).toBe(200);
  const body = JSON.parse(response.body) as { ok: boolean; code: string; message: string };
  expect(body.ok).toBe(false);
  expect(body.code).toBe(code);
  expect(body.message).toMatch(message);
  expect(body.message).not.toContain('secret-sensitive');
  expect(body.message).not.toContain('authority expired');
});

it('recovers the same operation after a committed registration loses its response', async () => {
  const server = await controller();
  let committedId: string | undefined;
  let attempts = 0;
  const session = server.provision(handlers({ registerWait: async request => {
    const operationId = request.operation_id;
    expect(operationId).toBeDefined();
    if (!committedId) committedId = operationId;
    expect(operationId).toBe(committedId);
    if (++attempts === 1) throw new Error('response lost after commit');
    return { ...registered, answer: { ...registered.answer, effect: 'unchanged', operation_id: committedId, replayed: true } };
  } }));
  const answer = await callSquawkWait({ kind: WAIT_KIND.pr, pr: wait.prUrl }, session.env);
  expect(attempts).toBe(2);
  expect(answer).toMatchObject({ ok: true, effect: 'unchanged', operation_id: committedId, wait_id: wait.id });
});

it('reports unknown after both registration responses are lost, with a stable retry ID', async () => {
  const server = await controller();
  const ids: Array<string | undefined> = [];
  const session = server.provision(handlers({ registerWait: async request => {
    ids.push(request.operation_id); throw new Error('no response evidence');
  } }));
  const answer = await callSquawkWait({ kind: WAIT_KIND.pr, pr: wait.prUrl }, session.env);
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  expect(answer).toMatchObject({ ok: false, effect: 'unknown', code: 'outcome_unknown', operation_id: ids[0] });
});

it('says nothing was created when no local tool capability exists before dispatch', async () => {
  expect(await callSquawkWait({ kind: WAIT_KIND.timer, seconds: 60 }, {})).toMatchObject({ ok: false, effect: 'refused', message: expect.stringContaining('Nothing was created') });
});

it('controller emits matching generated env names', async () => {
  vi.stubEnv('HSQ_PREVIEW', '1'); vi.stubEnv('HSQ_AUTOMATIONS', '0');
  const session = (await controller()).provision(handlers());
  for (const suffix of ['TOOL_TOKEN', 'TOOL_SOCKET', 'PREVIEW', 'AUTOMATIONS']) {
    expect(session.env[`CEZ_${suffix}`]).toBeDefined();
    expect(session.env[`HSQ_${suffix}`]).toBe(session.env[`CEZ_${suffix}`]);
  }
  expect(session.env.CEZ_AUTOMATIONS).toBe('0');
  expect(session.env.CEZ_PREVIEW).toBe('1');
});
