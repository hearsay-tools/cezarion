import { productName } from '../home/display.ts';
import { WAIT_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { ciWaitRequestSchema, ciWaitSchema, ciWaitResultSchema, ciWaitReceiptSchema } from '@open-mercato/cezar-contract/ci-wait';
import { previewServeResultSchema, type PreviewServeRequest, type PreviewServeResult } from '@open-mercato/cezar-contract/preview';
import { type SquawkWaitAnswer, squawkWaitRequestSchema } from '@open-mercato/cezar-contract/waits';
import { squawkServerInstructions, squawkToolEnvNames, squawkTools, doneToolDefinition, waitToolDefinition, waitAnswerHint } from './tools.ts';
import { waitInvalidInput } from './errors.ts';

describe('CI wait contract', () => {
  it('accepts merge supervision and requires bounded evidence for blocked results only', () => {
    expect(squawkWaitRequestSchema.parse({ kind: WAIT_KIND.pr, pr: 'https://github.com/org/repo/pull/12', until: 'merge_or_blocked' }))
      .toMatchObject({ until: 'merge_or_blocked' });
    const blocked = { outcome: 'blocked', headSha: 'a'.repeat(40), observedAt: new Date().toISOString(), checks: [], totalChecks: 0, truncated: false,
      mergeBlock: { reason: 'no_pending_merge', isInMergeQueue: false, autoMergeEnabled: false,
        event: { kind: 'queue_removal', createdAt: '2026-11-04T06:33:39Z', reason: 'failed_checks' } } };
    expect(ciWaitResultSchema.parse(blocked)).toEqual(blocked);
    const { mergeBlock, ...withoutEvidence } = blocked;
    expect(ciWaitResultSchema.safeParse(withoutEvidence).success).toBe(false);
    expect(ciWaitResultSchema.safeParse({ ...blocked, outcome: 'merged' }).success).toBe(false);
    expect(ciWaitResultSchema.safeParse({ ...blocked, mergeBlock: { ...mergeBlock, event: { ...mergeBlock.event, reason: 'x'.repeat(257) } } }).success).toBe(false);
  });
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
      expect(squawkTools(env).map(tool => tool.definition.name).slice(0, 4)).toEqual(['cezar_wait', 'cezar_ask', 'cezar_cancel_wait', 'cezar_done']);
      expect(squawkServerInstructions(env)).toContain('- cezar_done: load when the task is complete and verified.');
      expect(squawkServerInstructions(env)).toContain('- cezar_ask: load for a user decision or missing input');
    }
    expect(doneToolDefinition.description).toBe(`Finish the task, or in a workflow step that is not the last, finish that step. Call it when the goal is fully achieved and verified and you have no question for the user; end your turn after it answers. ${productName('Cezar')} closes the session at the end of this turn and cancels every open wait; after a step, ${productName('Cezar')} starts the next step, and the answer names it. It refuses, naming what to do first, while owned workers are live or uncollected, a worker question is unanswered, or your question to the user is still pending.`);
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

it('cezar_wait advertises worker, request and peer fields with their bounds', () => {
  const schema = waitToolDefinition.inputSchema as { properties: Record<string, any> };
  expect(schema.properties.kind.enum).toEqual(['pr', 'worker', 'request', 'peer', 'timer', 'process']);
  expect(schema.properties.kind.description).toMatch(/worker/);
  // hearsay-tools/cezarion#1995: each id list belongs to one kind.
  for (const [key, kind] of [['worker_ids', 'worker'], ['request_ids', 'request'], ['peer_ids', 'peer']]) {
    expect(schema.properties[key!]).toMatchObject({ type: 'array', minItems: 1, maxItems: 32 });
    expect(schema.properties[key!].description).toMatch(new RegExp(`^kind "${kind}":`));
  }
  expect(schema.properties.mode.enum).toEqual(['one', 'any', 'all']);
  expect(schema.properties.mode.description).toMatch(/^kind "worker" or "request":/);
  // One flat field serves every kind: it advertises ci's bounds and names the others in the description.
  expect(schema.properties.timeout_seconds).toMatchObject({ minimum: 1, maximum: 7200 });
  expect(schema.properties.timeout_seconds.description).toMatch(/kind "worker", "request" or "peer".*7200.*600/);
  expect(waitToolDefinition.description).toMatch(/kind "request"/);
  expect(waitToolDefinition.description).toMatch(/kind "peer"/);
  expect(waitToolDefinition.description).toMatch(/worker/);
  expect(squawkTools().find(tool => tool.definition.name === 'cezar_cancel_wait')!.definition.description).toMatch(/worker/);
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
  expect(schema.properties.kind.description).toMatch(/"process" wakes you when a background command ends/);
  const description = waitToolDefinition.description;
  expect(description).toContain('Times in the answers, such as `deadline`, are UTC.');
  // The tool list also loads inside omp, a standalone binary: the description names no path of its own.
  expect(description).toContain('`hsq job start <name> -- <command> [args...]` (your instructions give the full command for this session under "Long commands")');
  expect(description).toContain('pass the `pid` and `exitFile` it prints as `pid` and `exit_file`');
  expect(description).toContain(`the job outlives this session; ${productName('Cezar')} does not stop it.`);
  expect(description).toContain(`Its files are in $TMPDIR, which ${productName('Cezar')} removes when the task ends: for a job that must outlive the task, add \`--dir <a git-ignored directory in the worktree>\` before \`--\`.`);
  expect(description).toContain('Do not start a long command with `&`, `nohup`, `setsid` or your own background-task tool');
  // An agent whose batch wrote its exit file outside $TMPDIR started a watcher to copy it in.
  expect(description).toContain('For a command that is already running, or that writes its own status file somewhere else, pass only its `pid` and leave `exit_file` out.');
  expect(description).toContain('Never start a watcher or helper process to copy a file into $TMPDIR.');
  expect(schema.properties.exit_file.description).toMatch(/Leave it out for a command that is already running/);
  const pid = squawkWaitRequestSchema.safeParse({ kind: WAIT_KIND.process, pid: 1 });
  expect(waitInvalidInput(pid.success ? undefined : pid.error)).toBe('`pid` must be an integer of at least 2: the `pid` that the job start command printed (kind "process").');
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
  for (const { definition } of squawkTools({ CEZ_AUTOMATIONS: '1', CEZ_PREVIEW: '1' })) {
    expect(definition.inputSchema.type, definition.name).toBe('object');
    for (const key of ['oneOf', 'anyOf', 'allOf']) expect(definition.inputSchema, definition.name).not.toHaveProperty(key);
  }
  const scheduled = squawkTools({ CEZ_AUTOMATIONS: '1' }).find(tool => tool.definition.name === 'cezar_scheduled_tasks')!.definition.inputSchema;
  expect((scheduled.properties as Record<string, { enum?: string[] }>).action!.enum).toEqual(['list', 'show', 'update', 'pause', 'enable', 'cancel']);
  expect(scheduled.required).toEqual(['action']);
});

it('forwards CEZ_AUTOMATIONS including the explicit opt-out to adapters', () => {
  expect(squawkToolEnvNames({ CEZ_AUTOMATIONS: '1' })).toContain('CEZ_AUTOMATIONS');
  expect(squawkToolEnvNames({})).toContain('CEZ_AUTOMATIONS');
  expect(squawkToolEnvNames({ CEZ_AUTOMATIONS: '0' })).toContain('CEZ_AUTOMATIONS');
});

it('tells the agent when to enable a scheduled task and which ones to change', () => {
  const tools = squawkTools({ CEZ_AUTOMATIONS: '1' });
  expect(tools.find(tool => tool.definition.name === 'cezar_schedule_task')!.definition.description).toMatch(/enable: true only when the user/);
  expect(tools.find(tool => tool.definition.name === 'cezar_scheduled_tasks')!.definition.description).toMatch(/only the schedules the user asked you to manage/);
});

it('keeps legacy unavailable wait hints uncertain without an effect receipt', () => {
  const hint = waitAnswerHint({ ok: false, code: 'unavailable', message: 'transport failed' });
  expect(hint).toContain('Outcome unknown');
  expect(hint).not.toContain('Not registered');
  expect(hint).toContain('do not add a fallback wait');
});

describe('wait result guidance', () => {
  const receipt = { ok: true as const, wait_id: '4a6b6bf4-798c-4dc7-aede-e583428f667a', kind: WAIT_KIND.timer,
    deadline: '2026-11-05T14:00:00.000Z', open_waits: [] };
  const cases: Array<[string, SquawkWaitAnswer, string]> = [
    ['unknown transport outcome', { ok: false, effect: 'unknown', code: 'outcome_unknown', message: 'lost response' }, 'Outcome unknown. Retry the same operation_id'],
    ['retained deadline refusal', { ok: false, effect: 'refused', code: 'duplicate_deadline', message: 'retained' }, 'The retained wait remains active; do not cancel it'],
    ['known refusal', { ok: false, effect: 'refused', code: 'capacity', message: 'full' }, 'Not registered by this call'],
    ['receipt outside recent history', { ...receipt, replayed: true, wait_phase: 'unavailable' }, 'current wait state is unavailable. Inspect task history'],
    ['cancelled receipt', { ...receipt, replayed: true, wait_phase: 'cancelled' }, 'already settled; inspect its result'],
    ['resolved receipt', { ...receipt, replayed: true, wait_phase: 'resolved' }, 'already settled; inspect its result'],
    ['open operation replay', { ...receipt, replayed: true, wait_phase: 'open' }, 'Existing wait retained. This is its real ID and deadline'],
    ['semantic duplicate', { ...receipt, deduplicated: true, wait_phase: 'open' }, 'Existing wait retained. This is its real ID and deadline'],
    ['new registration', { ...receipt, effect: 'applied', wait_phase: 'open' }, 'Registered. End your turn to wait'],
  ];
  it.each(cases)('%s gives guidance consistent with its effect and current state', (_name, answer, guidance) => {
    expect(waitAnswerHint(answer)).toContain(guidance);
  });
});

it.each([
  { kind: WAIT_KIND.worker, worker_ids: ['11111111-1111-4111-8111-111111111111'] },
  { kind: 'request', request_ids: ['11111111-1111-4111-8111-111111111111'] },
  { kind: WAIT_KIND.peer, peer_ids: ['11111111-1111-4111-8111-111111111111'] },
])('names the accepted timeout range above the $kind bound', request => {
  const result = squawkWaitRequestSchema.safeParse({ ...request, timeout_seconds: 7201 });
  expect(result.success).toBe(false);
  expect(waitInvalidInput(result.success ? undefined : result.error)).toBe('`timeout_seconds` must be an integer between 1 and 7200 (kind "pr", "process", "worker", "request" or "peer").');
});
