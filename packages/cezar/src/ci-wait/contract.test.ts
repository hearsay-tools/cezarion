import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { ciWaitRequestSchema, ciWaitSchema, ciWaitResultSchema, ciWaitReceiptSchema } from '@open-mercato/cezar-contract/ci-wait';
import { previewServeResultSchema, type PreviewServeRequest, type PreviewServeResult } from '@open-mercato/cezar-contract/preview';
import { cezarWaitRequestSchema } from '@open-mercato/cezar-contract/waits';
import { cezarServerInstructions, cezarToolEnvNames, cezarTools, doneToolDefinition, waitToolDefinition } from './tools.ts';
import { waitInvalidInput } from './errors.ts';

describe('CI wait contract', () => {
  it('defaults timeout and rejects model-supplied authority and malformed PR URLs', () => {
    expect(ciWaitRequestSchema.parse({ pr: 'https://github.com/org/repo/pull/12' })).toEqual({ pr: 'https://github.com/org/repo/pull/12', until: 'checks', wake_on_conflict: true, timeout_seconds: 1800 });
    for (const pr of ['http://github.com/a/b/pull/1', 'https://user@github.com/a/b/pull/1', 'https://github.com:443/a/b/pull/1', 'https://github.com/a/b/pull/0', 'https://github.com/a/b/pull/1?q=x', 'https://github.com/a/b/pull/1#x', 'https://github.com/a/b/pull/1/', 'https://github.com/a/b/pull/9007199254740993']) {
      expect(ciWaitRequestSchema.safeParse({ pr }).success, pr).toBe(false);
    }
    for (const timeout_seconds of [0, 7201, 1.5]) expect(ciWaitRequestSchema.safeParse({ pr: 'https://github.com/a/b/pull/1', timeout_seconds }).success).toBe(false);
    expect(ciWaitRequestSchema.safeParse({ pr: 'https://github.com/a/b/pull/1', runId: 'elsewhere' }).success).toBe(false);
  });
  it('bounds persisted results and does not salvage malformed state as successful CI', () => {
    expect(ciWaitSchema.safeParse({ phase: 'registered' }).success).toBe(false);
    expect(ciWaitResultSchema.safeParse({ outcome: 'passed', headSha: 'a'.repeat(40), observedAt: new Date().toISOString(), checks: Array.from({length:101}, () => ({name:'check',state:'SUCCESS',link:''})), totalChecks:101, truncated:false }).success).toBe(false);
  });
});

it('rejects a persisted result larger than the total 32 KiB wire budget', () => {
  expect(ciWaitResultSchema.safeParse({ outcome:'passed',headSha:'a'.repeat(40),observedAt:new Date().toISOString(),checks:Array.from({length:100},()=>({name:'build',state:'SUCCESS',link:'https://example.com/'+ 'x'.repeat(2000)})),totalChecks:100,truncated:false }).success).toBe(false);
});


it('returns a bounded wire receipt without persisted authority or delivery state', () => {
  const receipt = {
    waitId: '4a6b6bf4-798c-4dc7-aede-e583428f667a',
    prUrl: 'https://github.com/org/repo/pull/12',
    repository: 'org/repo',
    prNumber: 12,
    headSha: 'a'.repeat(40),
    registeredAt: '2026-09-22T13:00:00.000Z',
    deadline: '2026-09-22T13:30:00.000Z',
    phase: 'registered',
  };
  expect(ciWaitReceiptSchema.safeParse(receipt).success).toBe(true);
  expect(ciWaitReceiptSchema.parse(receipt)).toEqual(receipt);
  for (const privateState of [
    { id: receipt.waitId },
    { generation: 'session-generation' },
    { turnId: 'originating-turn' },
    { wakeId: 'delivery-input' },
    { deliveredAt: receipt.deadline },
  ]) {
    expect(ciWaitReceiptSchema.safeParse({ ...receipt, ...privateState }).success).toBe(false);
  }
  const { waitId, ...identity } = receipt;
  expect(ciWaitSchema.safeParse({ ...identity, id: waitId, generation: 'session-generation', turnId: 'originating-turn', timeoutSeconds: 1800 }).success).toBe(true);
});

it.each([
  'manager_disposed', 'capability_revoked', 'run_missing', 'run_not_running', 'run_stopping',
  'session_replaced', 'session_closed', 'run_cancelled', 'finish_requested', 'generation_mismatch',
  'worker_wait_pending', 'worker_execution_stopped',
  'root_finish_pending', 'registration_aborted', 'turn_changed',
])('accepts the specific registration refusal %s without losing its diagnostic', async code => {
  const { ciWaitErrorSchema } = await import('@open-mercato/cezar-contract/ci-wait');
  expect(ciWaitErrorSchema.parse({ code, message: 'Blocking state; retry after resolving it.' }))
    .toEqual({ code, message: 'Blocking state; retry after resolving it.' });
  expect(ciWaitErrorSchema.safeParse({ code: 'invented_refusal', message: 'no' }).success).toBe(false);
});

// hearsay-tools/cezarion#1234: `cezar_ask` follows `cezar_wait`, and `cezar_done` closes the lifecycle
// tools, ahead of the preview tools.
describe('cezar_done tool contract', () => {
  it('lists cezar_ask and cezar_done with the wait tools and gives each a trigger line', () => {
    for (const env of [{}, { CEZ_PREVIEW: '1' }]) {
      expect(cezarTools(env).map(tool => tool.definition.name).slice(0, 4)).toEqual(['cezar_wait', 'cezar_ask', 'cezar_cancel_wait', 'cezar_done']);
      expect(cezarServerInstructions(env)).toContain('- cezar_done: load when the task is complete and verified.');
      expect(cezarServerInstructions(env)).toContain('- cezar_ask: load for a user decision or missing input');
    }
    expect(doneToolDefinition.description).toBe('Finish the task. Call it when the goal is fully achieved and verified and you have no question for the user; end your turn after it answers. Cezar closes the session at the end of this turn and cancels every open wait. It refuses, naming what to do first, while owned workers are live or uncollected, a worker question is unanswered, or your question to the user is still pending.');
    expect(doneToolDefinition.inputSchema).toMatchObject({ type: 'object', additionalProperties: false, properties: { summary: { type: 'string', maxLength: 2000 } } });
    expect(doneToolDefinition.inputSchema).not.toHaveProperty('required');
  });
});

// #781: the private preview route answers the agent a typed result with a recovery hint,
// so a bad call is something the agent can fix, never a bare 400.
describe('private preview-serve route', () => {
  const controllers: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(controllers.splice(0).map(owner => owner.close())); });
  async function session(registerPreview?: (request: PreviewServeRequest) => Promise<PreviewServeResult>) {
    const { CiToolController } = await import('./controller.ts');
    const owner = await CiToolController.start(); controllers.push(owner);
    const notWait = async (): Promise<never> => { throw new Error('not a CI test'); };
    return owner.provision({ registerWait: notWait, ask: notWait, cancelWait: notWait, finishTurn: notWait, registerPreview });
  }
  // One connection per call, as client.ts does: see raw() in controller.test.ts (hearsay-tools/cezarion#1484).
  function post(env: Record<string, string>, body: string, token = env.CEZ_TOOL_TOKEN!) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ socketPath: env.CEZ_TOOL_SOCKET, agent: false, path: '/api/v1/tools/preview-serve', method: 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' } }, res => {
        let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode!, body: text }));
      }); req.on('error', reject); req.end(body);
    });
  }
  const valid = { command: 'npm run dev -- --port 5173 --strictPort', port: 5173 };

  it('answers an invalid body 200 with invalid_input naming the field and a valid example call', async () => {
    vi.stubEnv('CEZ_PREVIEW', '1');
    const registerPreview = vi.fn(async () => ({ ok: true, code: 'registered' as const, message: 'm', hint: 'h' }));
    const { env } = await session(registerPreview);
    const response = await post(env, JSON.stringify({ port: 'x' }));
    expect(response.status).toBe(200);
    const result = previewServeResultSchema.parse(JSON.parse(response.body));
    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(result.message).toMatch(/`(command|port)`/);
    expect(result.hint).toContain('"port"');
    expect(result.hint).toContain('{ "command": "npm run dev -- --port 5173 --strictPort", "port": 5173 }');
    const port = previewServeResultSchema.parse(JSON.parse((await post(env, JSON.stringify({ command: 'vite', port: '5173abc' }))).body));
    expect(port.message).toBe('`port` must be an integer between 1 and 65535 (got "5173abc").');
    expect(previewServeResultSchema.parse(JSON.parse((await post(env, '{')).body)).code).toBe('invalid_input');
    expect(registerPreview).not.toHaveBeenCalled();
  });

  it('refuses a missing or unknown token with 401 before anything else', async () => {
    vi.stubEnv('CEZ_PREVIEW', '1');
    const registerPreview = vi.fn(async () => ({ ok: true, code: 'registered' as const, message: 'm', hint: 'h' }));
    const { env } = await session(registerPreview);
    expect((await post(env, JSON.stringify(valid), '')).status).toBe(401);
    expect((await post(env, JSON.stringify(valid), 'invalid')).status).toBe(401);
    expect(registerPreview).not.toHaveBeenCalled();
  });

  it('answers preview_disabled when CEZ_PREVIEW is not exactly 1, without registering', async () => {
    const registerPreview = vi.fn(async () => ({ ok: true, code: 'registered' as const, message: 'm', hint: 'h' }));
    const { env } = await session(registerPreview);
    for (const value of ['', '0', 'true']) {
      vi.stubEnv('CEZ_PREVIEW', value);
      const response = await post(env, JSON.stringify(valid));
      expect(response.status).toBe(200);
      expect(previewServeResultSchema.parse(JSON.parse(response.body))).toMatchObject({ ok: false, code: 'preview_disabled', hint: expect.stringMatching(/Do not retry/) });
    }
    expect(registerPreview).not.toHaveBeenCalled();
  });

  it('answers headless when the session has no preview registration', async () => {
    vi.stubEnv('CEZ_PREVIEW', '1');
    const { env } = await session();
    expect(previewServeResultSchema.parse(JSON.parse((await post(env, JSON.stringify(valid))).body))).toMatchObject({ ok: false, code: 'headless', hint: expect.stringMatching(/Do not retry/) });
  });

  it('hands the parsed request to registerPreview and returns its result; a failure is unavailable', async () => {
    vi.stubEnv('CEZ_PREVIEW', '1');
    const registered = { ok: true, code: 'registered' as const, message: 'Registered `:5173` (npm) for this task.', hint: 'Continue your work.' };
    const registerPreview = vi.fn(async () => registered);
    const { env } = await session(registerPreview);
    const response = await post(env, JSON.stringify({ ...valid, label: 'vite', extra: 'dropped' }));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual(registered);
    expect(registerPreview).toHaveBeenCalledWith({ ...valid, label: 'vite' }, expect.any(AbortSignal));
    const failing = await session(async () => { throw new Error('secret-sensitive'); });
    const failed = await post(failing.env, JSON.stringify(valid));
    expect(failed.body).not.toContain('secret-sensitive');
    expect(previewServeResultSchema.parse(JSON.parse(failed.body))).toMatchObject({ ok: false, code: 'unavailable' });
  });

  it('the MCP adapter returns the result as JSON plus the hint, isError when not ok', async () => {
    vi.stubEnv('CEZ_PREVIEW', '1');
    const { invokePreviewTool } = await import('./tools.ts');
    const { env } = await session();
    vi.stubEnv('CEZ_TOOL_SOCKET', env.CEZ_TOOL_SOCKET!); vi.stubEnv('CEZ_TOOL_TOKEN', env.CEZ_TOOL_TOKEN!);
    const result = await invokePreviewTool(valid);
    expect(result.isError).toBe(true);
    const [json, hint] = result.content[0]!.text.split('\n');
    expect(JSON.parse(json!)).toMatchObject({ ok: false, code: 'headless' });
    expect(hint).toBe(JSON.parse(json!).hint);
    vi.stubEnv('CEZ_TOOL_SOCKET', '');
    const unavailable = await invokePreviewTool(valid);
    expect(unavailable.isError).toBe(true);
    expect(JSON.parse(unavailable.content[0]!.text.split('\n')[0]!)).toMatchObject({ code: 'unavailable', hint: expect.stringMatching(/Retry once/) });
  });
});

it('cezar_wait advertises worker fields with their bounds', () => {
  const schema = waitToolDefinition.inputSchema as { properties: Record<string, any> };
  expect(schema.properties.kind.enum).toEqual(['pr', 'worker', 'timer', 'process']);
  expect(schema.properties.kind.description).toMatch(/worker/);
  for (const key of ['worker_ids', 'request_ids']) {
    expect(schema.properties[key]).toMatchObject({ type: 'array', minItems: 1, maxItems: 32 });
    expect(schema.properties[key].description).toMatch(/^kind "worker":/);
  }
  expect(schema.properties.mode.enum).toEqual(['one', 'any', 'all']);
  expect(schema.properties.mode.description).toMatch(/^kind "worker":/);
  // One flat field serves both kinds: it advertises ci's bounds and names the worker's in the description.
  expect(schema.properties.timeout_seconds).toMatchObject({ minimum: 1, maximum: 7200 });
  expect(schema.properties.timeout_seconds.description).toMatch(/kind "worker".*1800.*600/);
  expect(waitToolDefinition.description).toMatch(/worker/);
  expect(cezarTools().find(tool => tool.definition.name === 'cezar_cancel_wait')!.definition.description).toMatch(/worker/);
});

// hearsay-tools/cezarion#1446: the process kind, and the exit-file recipe every runner can follow.
it('cezar_wait advertises the process fields and tells the agent how to write the exit file', () => {
  const schema = waitToolDefinition.inputSchema as { properties: Record<string, any> };
  expect(schema.properties.pid).toMatchObject({ type: 'integer', minimum: 2 });
  expect(schema.properties.pid.description).toMatch(/^kind "process":/);
  expect(schema.properties.exit_file).toMatchObject({ type: 'string', maxLength: 4096 });
  expect(schema.properties.exit_file.description).toMatch(/^kind "process":/);
  expect(schema.properties.timeout_seconds.description).toMatch(/kind "process": 1–7200, default 1800/);
  expect(schema.properties.note.description).toMatch(/"process"/);
  expect(schema.properties.kind.description).toMatch(/"process" wakes you when a background command you started ends/);
  const description = waitToolDefinition.description;
  expect(description).toContain(`sh -c '( cmd > "$TMPDIR/build.log" 2>&1; echo $? > "$TMPDIR/build.exit" ) > /dev/null 2>&1 & echo $!'`);
  expect(description).toContain('Use a new exit file name for each command: a file that already exists resolves the wait at once.');
  expect(description).toContain('The job outlives this session and Cezar does not stop it.');
  const refused = cezarWaitRequestSchema.safeParse({ kind: 'human' });
  expect(waitInvalidInput(refused.success ? undefined : refused.error)).toBe('`kind` must be "ci", "worker", "timer" or "process"; ask the user with cezar_ask.');
  const pid = cezarWaitRequestSchema.safeParse({ kind: 'process', pid: 1 });
  expect(waitInvalidInput(pid.success ? undefined : pid.error)).toBe('`pid` must be an integer of at least 2: the PID that `echo $!` printed (kind "process").');
});

it('accepts old observations and the new bounded conflict metadata', () => {
 const old = {outcome:'passed',headSha:'a'.repeat(40),observedAt:new Date().toISOString(),checks:[],totalChecks:0,truncated:false};
 expect(ciWaitResultSchema.safeParse(old).success).toBe(true);
 expect(ciWaitResultSchema.safeParse({...old,outcome:'conflicting',mergeable:'CONFLICTING',mergeStateStatus:'DIRTY'}).success).toBe(true);
 expect(ciWaitResultSchema.safeParse({...old,mergeable:'DIRTY'}).success).toBe(false);
 expect(ciWaitResultSchema.safeParse({...old,mergeStateStatus:'x'.repeat(65)}).success).toBe(false);
});

// hearsay-tools/cezarion#1465: the Anthropic tool API refuses a top-level union in an input schema.
it('advertises every cezar tool input as one flat object', () => {
  for (const { definition } of cezarTools({ CEZ_AUTOMATIONS: '1', CEZ_PREVIEW: '1' })) {
    expect(definition.inputSchema.type, definition.name).toBe('object');
    for (const key of ['oneOf', 'anyOf', 'allOf']) expect(definition.inputSchema, definition.name).not.toHaveProperty(key);
  }
  const scheduled = cezarTools({ CEZ_AUTOMATIONS: '1' }).find(tool => tool.definition.name === 'cezar_scheduled_tasks')!.definition.inputSchema;
  expect((scheduled.properties as Record<string, { enum?: string[] }>).action!.enum).toEqual(['list', 'show', 'update', 'pause', 'enable', 'cancel']);
  expect(scheduled.required).toEqual(['action']);
});

it('forwards CEZ_AUTOMATIONS to the adapter only under the opt-in', () => {
  expect(cezarToolEnvNames({ CEZ_AUTOMATIONS: '1' })).toContain('CEZ_AUTOMATIONS');
  expect(cezarToolEnvNames({})).not.toContain('CEZ_AUTOMATIONS');
});

it('tells the agent when to enable a scheduled task and which ones to change', () => {
  const tools = cezarTools({ CEZ_AUTOMATIONS: '1' });
  expect(tools.find(tool => tool.definition.name === 'cezar_schedule_task')!.definition.description).toMatch(/enable: true only when the user/);
  expect(tools.find(tool => tool.definition.name === 'cezar_scheduled_tasks')!.definition.description).toMatch(/only the schedules the user asked you to manage/);
});
