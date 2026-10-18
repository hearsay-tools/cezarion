import { afterEach, describe, expect, it, vi } from 'vitest';
import { stat, access, rm, mkdtemp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { cezarCancelWaitAnswerSchema, cezarWaitAnswerSchema, ciWaitErrorSchema, ciWaitReceiptSchema, type CezarCancelWaitAnswer, type Wait } from '@open-mercato/cezar-contract';
import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CiToolController, type CezarToolHandlers, type WaitRegistration } from './controller.ts';
import { callCezarCancelWait, callCezarWait, callCiWait } from './client.ts';

const wait = { id: '11111111-1111-4111-8111-111111111111', generation: 'generation', turnId: 'turn', timeoutSeconds: 1800, prUrl: 'https://github.com/owner/repo/pull/1', repository: 'owner/repo', prNumber: 1, headSha: 'a'.repeat(40), registeredAt: '2026-09-22T00:00:00.000Z', deadline: '2026-09-22T00:30:00.000Z', phase: 'registered' as const };
const entry: Wait = { kind: 'ci', source: 'agent', via: 'cezar_wait', ...wait, phase: 'open' };
const openWait = { wait_id: wait.id, kind: 'ci' as const, deadline: wait.deadline, summary: 'CI for owner/repo#1' };
const registered: WaitRegistration = { answer: { ok: true, wait_id: wait.id, kind: 'ci', deadline: wait.deadline, open_waits: [openWait] }, wait: entry };
const cancelled: CezarCancelWaitAnswer = { cancelled: true, wait_id: wait.id, open_waits: [] };
function handlers(overrides: Partial<CezarToolHandlers> = {}): CezarToolHandlers {
  return { registerWait: async () => registered, cancelWait: async () => cancelled, ...overrides };
}
const coded = (code: string) => async (): Promise<never> => { throw Object.assign(new Error('secret-sensitive'), { code }); };
const controllers: CiToolController[] = [];
afterEach(async () => { await Promise.all(controllers.splice(0).map(controller => controller.close())); });
async function controller() { const value = await CiToolController.start(); controllers.push(value); return value; }
function raw(env: Record<string,string>, body: string, token = env.CEZ_TOOL_TOKEN, route = 'ci-wait') {
  return new Promise<{status:number;body:string}>((resolve, reject) => {
    const req = request({ socketPath: env.CEZ_TOOL_SOCKET, path: `/api/v1/tools/${route}`, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => {
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
    const receipt = await callCiWait({ pr: wait.prUrl }, session.env);
    expect(ciWaitReceiptSchema.parse(receipt)).toMatchObject({ waitId: wait.id });
    expect(receipt).not.toHaveProperty('generation');
    expect(receipt).not.toHaveProperty('turnId');
    await owner.close();
    await expect(callCiWait({ pr: wait.prUrl }, session.env)).rejects.toThrow(/unavailable/i);
    if (process.platform !== 'win32') await expect(access(dirname(session.env.CEZ_TOOL_SOCKET!))).rejects.toThrow();
  });
  it('rejects unknown/invalid/oversized bodies and unknown capabilities before registration', async () => {
    const register = vi.fn(async () => registered); const session = (await controller()).provision(handlers({ registerWait: register }));
    expect((await raw(session.env, JSON.stringify({pr:wait.prUrl}), 'invalid')).status).toBe(401);
    expect((await raw(session.env, JSON.stringify({pr:wait.prUrl,runId:'injected'}))).status).toBe(400);
    expect((await raw(session.env, '{')).status).toBe(400);
    expect((await raw(session.env, ' '.repeat(16385))).status).toBe(413);
    expect(register).not.toHaveBeenCalled();
  });
  it('revokes pending registration authority and rejects late receipt', async () => {
    let complete!: () => void; let signal!: AbortSignal;
    const session = (await controller()).provision(handlers({ registerWait: async (_request, _via, active) => { signal = active; await new Promise<void>(resolve => complete = resolve); active.throwIfAborted(); return registered; } }));
    const pending = callCiWait({ pr: wait.prUrl }, session.env);
    await vi.waitFor(() => expect(complete).toBeDefined());
    session.revoke(); expect(signal.aborted).toBe(true); complete();
    await expect(pending).rejects.toThrow(/unavailable|revoked/i);
    await expect(callCiWait({ pr: wait.prUrl }, session.env)).rejects.toThrow(/unavailable|revoked/i);
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
      await expect(callCiWait({pr:wait.prUrl}, session.env)).resolves.toMatchObject({waitId:wait.id});
    } finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; await rm(base, {recursive:true,force:true}); }
  });

  it('preserves actionable contract error codes without forwarding thrown messages', async () => {
    const session = (await controller()).provision(handlers({ registerWait: coded('wait_conflict') }));
    const response = await raw(session.env, JSON.stringify({pr:wait.prUrl}));
    expect(ciWaitErrorSchema.parse(JSON.parse(response.body))).toEqual({code:'wait_conflict',message:'A different CI wait is already active for this run.'});
    await expect(callCiWait({pr:wait.prUrl},session.env)).rejects.toThrow(/wait_conflict/);
  });

  it('bounds registration errors and never returns exception secrets', async () => {
    const session = (await controller()).provision(handlers({ registerWait: async () => { throw new Error('secret-token-sensitive'); } }));
    const response = await raw(session.env, JSON.stringify({ pr: wait.prUrl }));
    expect(response.status).toBe(503); expect(response.body).not.toContain('secret-token-sensitive');
  });
  it('adapter exits on harness stdin EOF while its controller remains alive', async () => {
    const session = (await controller()).provision(handlers());
    const child = spawn(session.descriptor.command, session.descriptor.args, {env:session.env,stdio:['pipe','pipe','ignore']});
    try {
      const initialized = new Promise<void>(resolve => child.stdout.once('data', () => resolve()));
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'eof-test',version:'1'}}})+'\n');
      await initialized;
      child.stdin.end();
      await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 1000 });
    } finally { child.kill('SIGKILL'); }
  }, 5000);

  it('hard controller death closes the connected MCP adapter without a model turn', async () => {
    const child = fork(fileURLToPath(new URL('./__fixtures__/controller-owner.mjs', import.meta.url)), [], { execArgv: ['--import', import.meta.resolve('tsx')], silent: true });
    const session = await new Promise<{ descriptor: { command: string; args: string[] }; env: Record<string,string> }>((resolve, reject) => { child.once('message', value => resolve(value as never)); child.once('error', reject); });
    const client = new Client({ name: 'owner-death-test', version: '1' });
    try {
      await client.connect(new StdioClientTransport({ ...session.descriptor, env: session.env, stderr: 'pipe' }));
      expect((await client.listTools()).tools).toHaveLength(3);
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
      expect(listed.tools.map(tool => tool.name)).toEqual(['cezar_wait_for_ci', 'cezar_wait', 'cezar_cancel_wait']);
      for (const tool of listed.tools) expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(register).not.toHaveBeenCalled();
      const result = await client.callTool({ name: 'cezar_wait_for_ci', arguments: { pr: wait.prUrl } });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain(wait.id);
      expect(JSON.stringify(result)).toContain('end your turn');
      expect(register).toHaveBeenCalledWith({ kind: 'ci', pr: wait.prUrl, timeout_seconds: 1800 }, 'cezar_wait_for_ci', expect.any(AbortSignal));
      const invalid = await client.callTool({ name: 'cezar_wait_for_ci', arguments: { pr: wait.prUrl, runId: 'evil' } });
      expect(invalid.isError).toBe(true); expect(register).toHaveBeenCalledTimes(1);
      const opened = await client.callTool({ name: 'cezar_wait', arguments: { kind: 'ci', pr: wait.prUrl } });
      expect(opened.isError).not.toBe(true);
      const [text] = (opened.content as Array<{ text: string }>).map(part => part.text);
      const [json, hint] = text!.split('\n');
      expect(cezarWaitAnswerSchema.parse(JSON.parse(json!))).toEqual(registered.answer);
      expect(hint).toBe('Registered. End your turn to wait; any open wait wakes you when it resolves.');
      expect(register).toHaveBeenLastCalledWith({ kind: 'ci', pr: wait.prUrl, timeout_seconds: 1800 }, 'cezar_wait', expect.any(AbortSignal));
      const closed = await client.callTool({ name: 'cezar_cancel_wait', arguments: { wait_id: wait.id } });
      expect(closed.isError).not.toBe(true);
      expect(cezarCancelWaitAnswerSchema.parse(JSON.parse((closed.content as Array<{ text: string }>)[0]!.text.split('\n')[0]!))).toEqual(cancelled);
      expect(cancel).toHaveBeenCalledWith({ wait_id: wait.id }, expect.any(AbortSignal));
      const refused = await client.callTool({ name: 'cezar_wait', arguments: { kind: 'timer', seconds: 59 } });
      expect(refused.isError).toBe(true); expect(register).toHaveBeenCalledTimes(2);
    } finally { await client.close(); }
  }, 15000);
});

// hearsay-tools/cezarion#1233: `cezar_wait` and `cezar_cancel_wait` reach the session's own handlers;
// the deprecated `cezar_wait_for_ci` route opens the same wait and answers today's receipt.
describe('private wait routes', () => {
  it('routes POST /tools/wait and /tools/cancel-wait to the capability handlers and keeps the ci-wait receipt shape', async () => {
    const register = vi.fn(async () => registered); const cancel = vi.fn(async () => cancelled);
    const session = (await controller()).provision(handlers({ registerWait: register, cancelWait: cancel }));
    const opened = await raw(session.env, JSON.stringify({ kind: 'ci', pr: wait.prUrl }), undefined, 'wait');
    expect(opened.status).toBe(200);
    expect(cezarWaitAnswerSchema.parse(JSON.parse(opened.body))).toEqual(registered.answer);
    expect(register).toHaveBeenLastCalledWith({ kind: 'ci', pr: wait.prUrl, timeout_seconds: 1800 }, 'cezar_wait', expect.any(AbortSignal));
    await expect(callCezarWait({ kind: 'timer', seconds: 600, note: 'deploy' }, session.env)).resolves.toEqual(registered.answer);
    expect(register).toHaveBeenLastCalledWith({ kind: 'timer', seconds: 600, note: 'deploy' }, 'cezar_wait', expect.any(AbortSignal));
    const closed = await raw(session.env, JSON.stringify({ wait_id: wait.id }), undefined, 'cancel-wait');
    expect(closed.status).toBe(200);
    expect(cezarCancelWaitAnswerSchema.parse(JSON.parse(closed.body))).toEqual(cancelled);
    expect(cancel).toHaveBeenCalledWith({ wait_id: wait.id }, expect.any(AbortSignal));
    await expect(callCezarCancelWait({ wait_id: wait.id }, session.env)).resolves.toEqual(cancelled);
    // The alias: same handler, its own `via`, and the receipt it answered before the wait list.
    const receipt = await raw(session.env, JSON.stringify({ pr: wait.prUrl, timeout_seconds: 60 }));
    expect(receipt.status).toBe(200);
    expect(ciWaitReceiptSchema.parse(JSON.parse(receipt.body))).toEqual({ waitId: wait.id, prUrl: wait.prUrl, repository: wait.repository, prNumber: wait.prNumber, headSha: wait.headSha, registeredAt: wait.registeredAt, deadline: wait.deadline, phase: 'registered' });
    expect(register).toHaveBeenLastCalledWith({ kind: 'ci', pr: wait.prUrl, timeout_seconds: 60 }, 'cezar_wait_for_ci', expect.any(AbortSignal));
    expect(Object.keys(JSON.parse(receipt.body)).sort()).toEqual(['deadline', 'headSha', 'phase', 'prNumber', 'prUrl', 'registeredAt', 'repository', 'waitId']);
  });

  it('answers invalid_request for a timer below 60 seconds without calling the handler', async () => {
    const register = vi.fn(async () => registered); const cancel = vi.fn(async () => cancelled);
    const session = (await controller()).provision(handlers({ registerWait: register, cancelWait: cancel }));
    const below = await raw(session.env, JSON.stringify({ kind: 'timer', seconds: 59 }), undefined, 'wait');
    expect(below.status).toBe(200);
    const answer = cezarWaitAnswerSchema.parse(JSON.parse(below.body));
    expect(answer).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(answer.ok === false && answer.message).toMatch(/seconds.*60.*7200/);
    for (const body of [{ kind: 'timer', seconds: 7201 }, { kind: 'worker' }, { kind: 'ci', pr: wait.prUrl, runId: 'injected' }, { pr: wait.prUrl }]) {
      expect(await callCezarWait(body, session.env)).toMatchObject({ ok: false, code: 'invalid_request' });
    }
    expect(JSON.parse((await raw(session.env, '{', undefined, 'wait')).body)).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(JSON.parse((await raw(session.env, ' '.repeat(16385), undefined, 'wait')).body)).toMatchObject({ ok: false, code: 'invalid_request' });
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
    const refused = await raw(session.env, JSON.stringify({ kind: 'ci', pr: wait.prUrl }), undefined, 'wait');
    expect(refused.status).toBe(200);
    expect(JSON.parse(refused.body)).toEqual({ ok: false, code: 'capacity', message: 'CI wait registration capacity is exhausted; retry later.' });
    const failed = await raw(session.env, JSON.stringify({ wait_id: wait.id }), undefined, 'cancel-wait');
    expect(JSON.parse(failed.body)).toMatchObject({ cancelled: false, code: 'unavailable' });
    expect(refused.body + failed.body).not.toContain('secret-sensitive');
    session.revoke();
    expect(await callCezarWait({ kind: 'timer', seconds: 600 }, session.env)).toMatchObject({ ok: false, code: 'unavailable' });
    expect(await callCezarCancelWait({ wait_id: wait.id }, session.env)).toMatchObject({ cancelled: false, code: 'unavailable' });
  });

  it('maps a returned refusal on the deprecated route to its old error envelope', async () => {
    const session = (await controller()).provision(handlers({ registerWait: async () => ({ answer: { ok: false, code: 'wait_conflict', message: 'not the fixed text' } }) }));
    const response = await raw(session.env, JSON.stringify({ pr: wait.prUrl }));
    expect(response.status).toBe(503);
    expect(ciWaitErrorSchema.parse(JSON.parse(response.body))).toEqual({ code: 'wait_conflict', message: 'A different CI wait is already active for this run.' });
    const timers = (await controller()).provision(handlers({ registerWait: async () => ({ answer: { ok: false, code: 'timers_disabled', message: 'off' } }) }));
    expect(JSON.parse((await raw(timers.env, JSON.stringify({ pr: wait.prUrl }))).body)).toMatchObject({ code: 'unavailable' });
  });
});

it.each([
  ['manager_disposed', /manager.*disposed/i], ['capability_revoked', /capability.*revoked/i],
  ['run_missing', /run.*no longer exists/i], ['run_not_running', /run.*not running/i],
  ['run_stopping', /run.*stopping/i], ['session_replaced', /session.*replaced|no active session/i],
  ['session_closed', /session.*closed/i], ['run_cancelled', /run.*cancelled/i],
  ['finish_requested', /finish.*requested/i], ['generation_mismatch', /earlier session/i],
  ['human_ask_pending', /human question.*pending/i], ['human_ask_unanswered', /human question.*unanswered/i],
  ['worker_wait_pending', /worker wait.*[Ee]nd your turn/], ['worker_execution_stopped', /worker execution.*stopped/i],
  ['root_finish_pending', /parent.*finishing/i], ['registration_aborted', /registration.*interrupted/i],
  ['turn_changed', /turn.*changed/i], ['unauthorized', /capability.*missing|revoked/i],
] as const)('returns a safe actionable message for %s', async (code, message) => {
  const session = (await controller()).provision(handlers({ registerWait: coded(code) }));
  const response = await raw(session.env, JSON.stringify({ pr: wait.prUrl }));
  expect(response.status).toBe(503);
  const body = ciWaitErrorSchema.parse(JSON.parse(response.body));
  expect(body.code).toBe(code);
  expect(body.message).toMatch(message);
  expect(body.message).not.toContain('secret-sensitive');
  expect(body.message).not.toContain('authority expired');
});
