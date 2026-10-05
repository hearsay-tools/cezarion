import type { ExtractSchema } from 'hono/types';
import type { PreviewStopRequest, PreviewStopResult } from '@open-mercato/cezar-contract';
import type { CiToolApp } from './controller.ts';
import { request } from 'node:http';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { previewStopRequestSchema, previewStopResultSchema } from '@open-mercato/cezar-contract';
import { CiToolController } from './controller.ts';
import { callPreviewStop } from './client.ts';
import { invokePreviewStopTool } from './tools.ts';

const stopped = { ok: true, code: 'stopped' as const, message: 'Stopped.', hint: 'Continue.' };
const controllers: CiToolController[] = [];
afterEach(async () => { await Promise.all(controllers.map(controller => controller.close())); controllers.length = 0; vi.unstubAllEnvs(); });
async function session(stop?: Parameters<CiToolController['provision']>[2]) {
  const controller = await CiToolController.start(); controllers.push(controller);
  return controller.provision(async () => { throw new Error('Not a CI test'); }, undefined, stop);
}
function post(env: Record<string, string>, body: string, token = env.CEZ_TOOL_TOKEN!) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ socketPath: env.CEZ_TOOL_SOCKET, path: '/api/v1/tools/preview-stop', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode!, body }));
    }); req.on('error', reject); req.end(body);
  });
}
describe('preview stop private capability', () => {
  it('retains the exact request and response in the chained private route type', () => {
    type Route = ExtractSchema<CiToolApp>['/api/v1/tools/preview-stop']['$post'];
    expectTypeOf<Route['input']>().toEqualTypeOf<{ json: PreviewStopRequest }>();
    expectTypeOf<Extract<Route['output'], { ok: boolean }>>().toEqualTypeOf<PreviewStopResult>();
  });

  it('validates port/restart, rejects model authority and requires complete typed answers', () => {
    expect(previewStopRequestSchema.parse({ port: 5173 })).toEqual({ port: 5173 });
    for (const input of [{ port: 0 }, { port: 65536 }, { port: 1.5 }, { port: '5173' }, { port: 5173, restart: 'true' }, { port: 5173, runId: 'other' }, { port: 5173, command: 'evil' }]) {
      expect(previewStopRequestSchema.safeParse(input).success).toBe(false);
    }
    expect(previewStopResultSchema.parse(stopped)).toEqual(stopped);
    expect(previewStopResultSchema.safeParse({ ...stopped, hint: undefined }).success).toBe(false);
  });

  it('authenticates before validation, gates exact opt-in, and gives repair hints', async () => {
    const stop = vi.fn(async () => stopped);
    const { env } = await session(stop);
    expect((await post(env, '{}', 'wrong')).status).toBe(401);
    for (const flag of ['', '0', 'true']) {
      vi.stubEnv('CEZ_PREVIEW', flag);
      expect(await callPreviewStop({ port: 5173 }, env)).toMatchObject({ code: 'preview_disabled' });
    }
    vi.stubEnv('CEZ_PREVIEW', '1');
    for (const body of ['{', '{}', '{"port":5173,"restart":"true"}', '{"port":5173,"runId":"other"}', JSON.stringify({ port: 5173, extra: 'x'.repeat(17000) })]) {
      const response = await post(env, body);
      expect(response.status).toBe(200);
      expect(previewStopResultSchema.parse(JSON.parse(response.body))).toMatchObject({ code: 'invalid_input', hint: expect.stringContaining('"restart": true') });
    }
    expect(stop).not.toHaveBeenCalled();
    expect(await callPreviewStop({ port: 5173, restart: true }, env)).toEqual(stopped);
    expect(stop).toHaveBeenCalledWith({ port: 5173, restart: true }, expect.any(AbortSignal));
  });

  it('isolates callbacks per session, revokes in-flight calls, and refuses missing capabilities', async () => {
    vi.stubEnv('CEZ_PREVIEW', '1');
    const firstStop = vi.fn(async () => stopped);
    const first = await session(firstStop);
    const second = await session(async () => ({ ...stopped, code: 'restarted' }));
    expect(await callPreviewStop({ port: 5173 }, second.env)).toMatchObject({ code: 'restarted' });
    expect(firstStop).not.toHaveBeenCalled();
    first.revoke();
    expect((await post(first.env, '{"port":5173}')).status).toBe(401);
    expect(await callPreviewStop({ port: 5173 }, (await session()).env)).toMatchObject({ code: 'headless' });
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const pending = await session(async (_, signal) => { entered(); await gate; expect(signal.aborted).toBe(true); return stopped; });
    const answer = post(pending.env, '{"port":5173}');
    await ready; pending.revoke(); finish();
    expect((await answer).status).toBe(401);
  });

  it('returns safe transport failures and JSON plus a hint through MCP', async () => {
    vi.stubEnv('CEZ_PREVIEW', '1');
    const { env } = await session(async () => stopped);
    vi.stubEnv('CEZ_TOOL_SOCKET', env.CEZ_TOOL_SOCKET!); vi.stubEnv('CEZ_TOOL_TOKEN', env.CEZ_TOOL_TOKEN!);
    const answer = await invokePreviewStopTool({ port: 5173 });
    expect(answer).toMatchObject({ isError: false, details: stopped });
    expect(answer.content[0]!.text).toBe(`${JSON.stringify(stopped)}\n${stopped.hint}`);
    const failing = await session(async () => { throw new Error('secret'); });
    expect(await callPreviewStop({ port: 5173 }, failing.env)).toMatchObject({ code: 'unavailable' });
    expect(await callPreviewStop({ port: 5173 }, {})).toMatchObject({ code: 'unavailable' });
    vi.stubEnv('CEZ_TOOL_SOCKET', '');
    expect(await invokePreviewStopTool({ port: 5173 })).toMatchObject({ isError: true, details: { code: 'unavailable' } });
  });
});
