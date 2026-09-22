import { afterEach, describe, expect, it, vi } from 'vitest';
import { stat, access, rm, mkdtemp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ciWaitErrorSchema, ciWaitReceiptSchema } from '@open-mercato/cezar-contract';
import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CiToolController } from './controller.ts';
import { callCiWait } from './client.ts';

const wait = { id: '11111111-1111-4111-8111-111111111111', generation: 'generation', turnId: 'turn', timeoutSeconds: 1800, prUrl: 'https://github.com/owner/repo/pull/1', repository: 'owner/repo', prNumber: 1, headSha: 'a'.repeat(40), registeredAt: '2026-09-22T00:00:00.000Z', deadline: '2026-09-22T00:30:00.000Z', phase: 'registered' as const };
const controllers: CiToolController[] = [];
afterEach(async () => { await Promise.all(controllers.splice(0).map(controller => controller.close())); });
async function controller() { const value = await CiToolController.start(); controllers.push(value); return value; }
function raw(env: Record<string,string>, body: string, token = env.CEZ_TOOL_TOKEN) {
  return new Promise<{status:number;body:string}>((resolve, reject) => {
    const req = request({ socketPath: env.CEZ_TOOL_SOCKET, path: '/api/v1/tools/ci-wait', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode!, body }));
    }); req.on('error', reject); req.end(body);
  });
}
describe('private CI controller', () => {
  it('has a private IPC endpoint, secret-free descriptor, and removes resources on close', async () => {
    const owner = await controller(); const session = owner.provision(async () => wait);
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
    const register = vi.fn(async () => wait); const session = (await controller()).provision(register);
    expect((await raw(session.env, JSON.stringify({pr:wait.prUrl}), 'invalid')).status).toBe(401);
    expect((await raw(session.env, JSON.stringify({pr:wait.prUrl,runId:'injected'}))).status).toBe(400);
    expect((await raw(session.env, '{')).status).toBe(400);
    expect((await raw(session.env, ' '.repeat(16385))).status).toBe(413);
    expect(register).not.toHaveBeenCalled();
  });
  it('revokes pending registration authority and rejects late receipt', async () => {
    let complete!: () => void; let signal!: AbortSignal;
    const session = (await controller()).provision(async (_request, active) => { signal = active; await new Promise<void>(resolve => complete = resolve); active.throwIfAborted(); return wait; });
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
      const session = (await controller()).provision(async () => wait);
      expect(Buffer.byteLength(session.env.CEZ_TOOL_SOCKET!)).toBeLessThan(100);
      await expect(callCiWait({pr:wait.prUrl}, session.env)).resolves.toMatchObject({waitId:wait.id});
    } finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; await rm(base, {recursive:true,force:true}); }
  });

  it('preserves actionable contract error codes without forwarding thrown messages', async () => {
    const session = (await controller()).provision(async () => { throw Object.assign(new Error('secret-sensitive'), { code: 'wait_conflict' }); });
    const response = await raw(session.env, JSON.stringify({pr:wait.prUrl}));
    expect(ciWaitErrorSchema.parse(JSON.parse(response.body))).toEqual({code:'wait_conflict',message:'A different CI wait is already active for this run.'});
    await expect(callCiWait({pr:wait.prUrl},session.env)).rejects.toThrow(/wait_conflict/);
  });

  it('bounds registration errors and never returns exception secrets', async () => {
    const session = (await controller()).provision(async () => { throw new Error('secret-token-sensitive'); });
    const response = await raw(session.env, JSON.stringify({ pr: wait.prUrl }));
    expect(response.status).toBe(503); expect(response.body).not.toContain('secret-token-sensitive');
  });
  it('adapter exits on harness stdin EOF while its controller remains alive', async () => {
    const session = (await controller()).provision(async () => wait);
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
      expect((await client.listTools()).tools).toHaveLength(1);
      const closed = new Promise<void>(resolve => { client.onclose = resolve; });
      child.kill('SIGKILL');
      await closed;
    } finally { child.kill('SIGKILL'); await client.close(); if (process.platform !== 'win32') await rm(dirname(session.env.CEZ_TOOL_SOCKET!), { recursive: true, force: true }); }
  }, 10000);

  it('bundled MCP negotiates, lists only CI without registering, and invokes real IPC', async () => {
    const register = vi.fn(async () => wait); const session = (await controller()).provision(register);
    const client = new Client({ name: 'ci-test', version: '1' });
    const transport = new StdioClientTransport({ ...session.descriptor, env: { ...session.env }, stderr: 'pipe' });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name)).toEqual(['cezar_wait_for_ci']);
      expect(listed.tools[0]!.inputSchema.additionalProperties).toBe(false);
      expect(register).not.toHaveBeenCalled();
      const result = await client.callTool({ name: 'cezar_wait_for_ci', arguments: { pr: wait.prUrl } });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain(wait.id);
      expect(JSON.stringify(result)).toContain('end your turn');
      expect(register).toHaveBeenCalledWith({ pr: wait.prUrl, timeout_seconds: 1800 }, expect.any(AbortSignal));
      const invalid = await client.callTool({ name: 'cezar_wait_for_ci', arguments: { pr: wait.prUrl, runId: 'evil' } });
      expect(invalid.isError).toBe(true); expect(register).toHaveBeenCalledTimes(1);
    } finally { await client.close(); }
  }, 15000);
});
