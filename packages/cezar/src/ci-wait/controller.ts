import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { previewStopResult } from '../preview/registration.ts';
import { askErrorMessage, askInvalidInput, ciErrorMessage, doneErrorMessage, doneInvalidInput, previewInvalidInput, previewOversized, previewRefusal, scheduleInvalidInput, scheduleRefusal, waitInvalidInput } from './errors.ts';
import { automationsToolEnabled, previewToolEnabled } from './tools.ts';
import { SCHEDULED_TASK_LIMITS, scheduleTaskAnswerSchema, scheduleTaskRequestSchema, scheduledTasksAnswerSchema, scheduledTasksRequestSchema, type ScheduleTaskAnswer, type ScheduleTaskRequest, type ScheduledTasksAnswer, type ScheduledTasksRequest } from '@open-mercato/cezar-contract/scheduled-tasks';
import { cezarAskAnswerSchema, cezarAskRequestSchema, cezarCancelWaitAnswerSchema, cezarCancelWaitRequestSchema, cezarDoneAnswerSchema, cezarDoneRequestSchema, cezarWaitAnswerSchema, cezarWaitRequestSchema, type CezarAskAnswer, type CezarAskRequest, type CezarCancelWaitAnswer, type CezarCancelWaitRequest, type CezarDoneAnswer, type CezarDoneRequest, type CezarWaitAnswer, type CezarWaitRequest, type CezarWaitRequestInput, type Wait, type WaitVia } from '@open-mercato/cezar-contract/waits';
import { ciWaitErrorCodeSchema } from '@open-mercato/cezar-contract/ci-wait';
import { previewStopRequestSchema, previewStopResultSchema, type PreviewStopRequest, type PreviewStopResult, previewServeRequestSchema, previewServeResultSchema, type PreviewServeRequest, type PreviewServeResult } from '@open-mercato/cezar-contract/preview';
import { jsonZodValidator } from '../server/validators.ts';
import type { AgentRunSpec } from '../core/agent-runner.ts';

/**
 * hearsay-tools/cezarion#1233: what `registerWait` settles to. The agent sees `answer`; an accepted
 * registration also carries the entry it opened.
 */
export type WaitRegistration =
  | { answer: Extract<CezarWaitAnswer, { ok: true }>; wait: Wait }
  | { answer: Extract<CezarWaitAnswer, { ok: false }> };
/** `signal` aborts when the session's capability is revoked (cancel, stop, session end). */
type PreviewRegistration = (request: PreviewServeRequest, signal: AbortSignal) => Promise<PreviewServeResult>;
type PreviewStop = (request: PreviewStopRequest, signal: AbortSignal) => Promise<PreviewStopResult>;
/** The session's trusted callbacks: run identity comes from here, never from the model's arguments. */
export type CezarToolHandlers = {
  /** `via` names the tool that opened the wait. */
  registerWait: (request: CezarWaitRequestInput, via: WaitVia, signal: AbortSignal) => Promise<WaitRegistration>;
  /** `cezar_ask` (hearsay-tools/cezarion#1234): opens the run's human wait with its card. */
  ask: (request: CezarAskRequest, signal: AbortSignal) => Promise<CezarAskAnswer>;
  cancelWait: (request: CezarCancelWaitRequest, signal: AbortSignal) => Promise<CezarCancelWaitAnswer>;
  /** `cezar_done` (hearsay-tools/cezarion#1234): accepted means the run, or a workflow step that is not the last, finishes at this turn's end (hearsay-tools/cezarion#1620). */
  finishTurn: (request: CezarDoneRequest, signal: AbortSignal) => Promise<CezarDoneAnswer>;
  /** #781: absent where no cockpit owns the run, which the route answers as `headless`. */
  registerPreview?: PreviewRegistration | undefined;
  stopPreview?: PreviewStop | undefined;
  /** hearsay-tools/cezarion#1465: absent where no cockpit serves the project, answered as `unavailable`. */
  scheduleTask?: (request: ScheduleTaskRequest, signal: AbortSignal) => Promise<ScheduleTaskAnswer>;
  scheduledTasks?: (request: ScheduledTasksRequest, signal: AbortSignal) => Promise<ScheduledTasksAnswer>;
};
type Capability = CezarToolHandlers & { lifetime: AbortController };
export type CiToolSession = { descriptor: NonNullable<AgentRunSpec['cezarTools']>; env: Record<string, string>; revoke(): void };
const unavailable = { code: 'unavailable' as const, message: ciErrorMessage('unavailable') };
/** `cezar_ask` carries up to 20,000 characters of context (hearsay-tools/cezarion#1458). JSON can
 *  escape a character to six bytes, so the largest valid card (context, four questions with four
 *  options, every field at its limit) is about 166 KB; 256 KiB admits it with room to spare. */
const ASK_BODY_LIMIT = 262_144;

/** Separate from the cockpit and delegation APIs. No TCP listener or durable credentials. */
export class CiToolController {
  private readonly capabilities = new Map<string, Capability>();
  private readonly sockets = new Set<Socket>();
  private closed = false;
  private constructor(private readonly server: Server, private readonly address: string, private readonly directory?: string) {}

  static async start(): Promise<CiToolController> {
    let directory: string | undefined;
    let server: Server | undefined;
    try {
      // sockaddr_un is only 104–108 bytes on supported Unix platforms. Agent
      // worktree TMPDIRs can be much longer; the endpoint must not inherit that.
      const temporaryRoot = Buffer.byteLength(tmpdir()) > 64 ? '/tmp' : tmpdir();
      directory = process.platform === 'win32' ? undefined : await mkdtemp(join(temporaryRoot, 'cez-ci-'));
      if (directory) await chmod(directory, 0o700);
      const address = directory ? join(directory, 'ipc') : `\\\\.\\pipe\\cezar-ci-${randomUUID()}`;
      server = createServer();
      const controller = new CiToolController(server, address, directory);
      const app = ciToolRoutes(controller.capabilities);
      server.on('request', getRequestListener(app.fetch));
      server.on('connection', socket => { controller.sockets.add(socket); socket.on('close', () => controller.sockets.delete(socket)); });
      server.maxConnections = 64;
      server.headersTimeout = 5000;
      server.requestTimeout = 15000;
      await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(address, () => { server!.off('error', reject); resolve(); }); });
      if (directory) await chmod(address, 0o600);
      server.unref();
      return controller;
    } catch {
      server?.close();
      server?.closeAllConnections();
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw new Error('CI tool unavailable: private IPC could not start');
    }
  }

  provision(handlers: CezarToolHandlers): CiToolSession {
    if (this.closed) throw new Error(unavailable.message);
    const token = randomBytes(32).toString('hex');
    const capability: Capability = { ...handlers, lifetime: new AbortController() };
    this.capabilities.set(token, capability);
    const entry = fileURLToPath(new URL('./mcp.js', import.meta.url));
    // Source execution uses tsx already installed by the developer; installed artifacts use plain Node.
    const source = import.meta.url.endsWith('.ts');
    return {
      descriptor: { name: `cezar_ci_${randomUUID().replaceAll('-', '')}`, command: process.execPath, args: source ? ['--import', fileURLToPath(import.meta.resolve('tsx')), entry.replace(/\.js$/, '.ts')] : [entry] },
      // #781: the session carries the preview opt-in, so its runner admits and forwards exactly
      // the tools this session's adapter lists.
      env: { CEZ_TOOL_TOKEN: token, CEZ_TOOL_SOCKET: this.address, ...(previewToolEnabled() ? { CEZ_PREVIEW: '1' } : {}), ...(automationsToolEnabled() ? { CEZ_AUTOMATIONS: '1' } : {}) },
      revoke: () => { this.capabilities.delete(token); capability.lifetime.abort(); },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const capability of this.capabilities.values()) capability.lifetime.abort();
    this.capabilities.clear();
    const closed = new Promise<void>(resolve => this.server.close(() => resolve()));
    for (const socket of this.sockets) socket.destroy();
    await closed;
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}

/** A refusal's code when it is a fixed CI code, so its message is ours and never the thrower's. */
function ciRefusalCode(code: unknown) {
  const parsed = ciWaitErrorCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : undefined;
}
const thrownCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? error.code : undefined;

/**
 * Typed private route inventory: GET ci-wait holds adapter lifetime (the path is historical; its POST
 * went with `cezar_wait_for_ci` in hearsay-tools/cezarion#1236); POST wait opens a CI, worker or
 * timer wait and POST cancel-wait closes one (hearsay-tools/cezarion#1233); POST ask opens the human
 * wait and POST done finishes the task at the turn's end (hearsay-tools/cezarion#1234); POST
 * preview-serve registers a dev server (#781); preview-stop controls its approved process (#803);
 * POST schedule-task and scheduled-tasks create and manage one-time schedules (hearsay-tools/cezarion#1465).
 */
export function ciToolRoutes(capabilities: Map<string, Capability>) {
  const authorized = (authorization: string | undefined) => {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    const capability = token ? capabilities.get(token) : undefined;
    return capability && !capability.lifetime.signal.aborted ? capability : undefined;
  };
  const unauthorized = { code: 'unauthorized' as const, message: ciErrorMessage('unauthorized') };
  return new Hono<{ Variables: { capability: Capability } }>()
    .use('/api/v1/tools/ci-wait', async (c, next) => {
      const capability = authorized(c.req.header('authorization'));
      if (!capability) return c.json(unauthorized, 401);
      c.set('capability', capability);
      await next();
    })
    .get('/api/v1/tools/ci-wait', c => {
      const signal = c.get('capability').lifetime.signal;
      let release = () => {};
      return new Response(new ReadableStream<Uint8Array>({ start(stream) {
        stream.enqueue(new TextEncoder().encode('connected\n'));
        const close = () => { try { stream.close(); } catch {} };
        signal.addEventListener('abort', close, { once: true });
        release = () => signal.removeEventListener('abort', close);
      }, cancel() { release(); } }), { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
    })
    .use('/api/v1/tools/wait', async (c, next) => {
      const capability = authorized(c.req.header('authorization'));
      if (!capability) return c.json(unauthorized, 401);
      c.set('capability', capability);
      await next();
    })
    // The agent fixes a bad call from the message, so refusals answer 200 with a typed result.
    .post('/api/v1/tools/wait', bodyLimit({ maxSize: 16_384, onError: c => c.json({ ok: false as const, code: 'invalid_request' as const, message: 'The arguments exceed 16 KiB.' }) }), jsonZodValidator(cezarWaitRequestSchema, { invalid: (c, error) => c.json({ ok: false as const, code: 'invalid_request' as const, message: waitInvalidInput(error) }) }), async c => {
      const capability = c.get('capability');
      try {
        const { answer } = await capability.registerWait(c.req.valid('json'), 'cezar_wait', capability.lifetime.signal);
        capability.lifetime.signal.throwIfAborted();
        return c.json(cezarWaitAnswerSchema.parse(answer));
      } catch (error) {
        if (capability.lifetime.signal.aborted) return c.json({ code: 'capability_revoked' as const, message: ciErrorMessage('capability_revoked') }, 401);
        const code = ciRefusalCode(thrownCode(error)) ?? 'unavailable';
        return c.json({ ok: false as const, code, message: ciErrorMessage(code) });
      }
    })
    .use('/api/v1/tools/ask', async (c, next) => {
      const capability = authorized(c.req.header('authorization'));
      if (!capability) return c.json(unauthorized, 401);
      c.set('capability', capability);
      await next();
    })
    .post('/api/v1/tools/ask', bodyLimit({ maxSize: ASK_BODY_LIMIT, onError: c => c.json({ ok: false as const, code: 'invalid_request' as const, message: 'The arguments exceed 256 KiB.' }) }), jsonZodValidator(cezarAskRequestSchema, { invalid: (c, error) => c.json({ ok: false as const, code: 'invalid_request' as const, message: askInvalidInput(error) }) }), async c => {
      const capability = c.get('capability');
      try {
        const answer = cezarAskAnswerSchema.parse(await capability.ask(c.req.valid('json'), capability.lifetime.signal));
        capability.lifetime.signal.throwIfAborted();
        return c.json(answer);
      } catch {
        if (capability.lifetime.signal.aborted) return c.json({ code: 'capability_revoked' as const, message: ciErrorMessage('capability_revoked') }, 401);
        return c.json({ ok: false as const, code: 'unavailable' as const, message: askErrorMessage('unavailable') });
      }
    })
    .use('/api/v1/tools/cancel-wait', async (c, next) => {
      const capability = authorized(c.req.header('authorization'));
      if (!capability) return c.json(unauthorized, 401);
      c.set('capability', capability);
      await next();
    })
    .post('/api/v1/tools/cancel-wait', bodyLimit({ maxSize: 16_384, onError: c => c.json({ cancelled: false as const, code: 'invalid_request' as const, message: 'The arguments exceed 16 KiB.' }) }), jsonZodValidator(cezarCancelWaitRequestSchema, { invalid: (c, error) => c.json({ cancelled: false as const, code: 'invalid_request' as const, message: waitInvalidInput(error) }) }), async c => {
      const capability = c.get('capability');
      try {
        const answer = cezarCancelWaitAnswerSchema.parse(await capability.cancelWait(c.req.valid('json'), capability.lifetime.signal));
        capability.lifetime.signal.throwIfAborted();
        return c.json(answer);
      } catch {
        if (capability.lifetime.signal.aborted) return c.json({ code: 'capability_revoked' as const, message: ciErrorMessage('capability_revoked') }, 401);
        return c.json({ cancelled: false as const, code: 'unavailable' as const, message: ciErrorMessage('unavailable') });
      }
    })
    .use('/api/v1/tools/done', async (c, next) => {
      const capability = authorized(c.req.header('authorization'));
      if (!capability) return c.json(unauthorized, 401);
      c.set('capability', capability);
      await next();
    })
    .post('/api/v1/tools/done', bodyLimit({ maxSize: 16_384, onError: c => c.json({ ok: false as const, code: 'invalid_request' as const, message: 'The arguments exceed 16 KiB.' }) }), jsonZodValidator(cezarDoneRequestSchema, { invalid: (c, error) => c.json({ ok: false as const, code: 'invalid_request' as const, message: doneInvalidInput(error) }) }), async c => {
      const capability = c.get('capability');
      try {
        const answer = cezarDoneAnswerSchema.parse(await capability.finishTurn(c.req.valid('json'), capability.lifetime.signal));
        capability.lifetime.signal.throwIfAborted();
        return c.json(answer);
      } catch {
        if (capability.lifetime.signal.aborted) return c.json({ code: 'capability_revoked' as const, message: ciErrorMessage('capability_revoked') }, 401);
        return c.json({ ok: false as const, code: 'unavailable' as const, message: doneErrorMessage('unavailable') });
      }
    })
    .use('/api/v1/tools/preview-stop', async (c, next) => {
      const capability = authorized(c.req.header('authorization'));
      if (!capability) return c.json(unauthorized, 401);
      c.set('capability', capability);
      await next();
    })
    .post('/api/v1/tools/preview-stop', bodyLimit({ maxSize: 16_384, onError: c => c.json(previewStopResult('invalid_input')) }), async (c, next) => {
      if (!previewToolEnabled()) return c.json(previewStopResult('preview_disabled'));
      await next();
    }, jsonZodValidator(previewStopRequestSchema, { invalid: c => c.json(previewStopResult('invalid_input')) }), async c => {
      const capability = c.get('capability');
      if (!capability.stopPreview) return c.json(previewStopResult('headless'));
      try {
        const result = previewStopResultSchema.parse(await capability.stopPreview(c.req.valid('json'), capability.lifetime.signal));
        capability.lifetime.signal.throwIfAborted();
        return c.json(result);
      } catch {
        if (capability.lifetime.signal.aborted) return c.json({ code: 'capability_revoked' as const, message: ciErrorMessage('capability_revoked') }, 401);
        return c.json(previewStopResult('unavailable'));
      }
    })
    .use('/api/v1/tools/preview-serve', async (c, next) => {
      const capability = authorized(c.req.header('authorization'));
      if (!capability) return c.json(unauthorized, 401);
      c.set('capability', capability);
      await next();
    })
    // The agent fixes a bad call from the hint, so refusals answer 200 with a typed result. The
    // flag gate runs before validation: off means off, whatever the body.
    .post('/api/v1/tools/preview-serve', bodyLimit({ maxSize: 16_384, onError: c => c.json(previewOversized()) }), async (c, next) => {
      if (!previewToolEnabled()) return c.json(previewRefusal('preview_disabled'));
      await next();
    }, jsonZodValidator(previewServeRequestSchema, { invalid: (c, error, input) => c.json(previewInvalidInput(error, input)) }), async c => {
      const capability = c.get('capability');
      if (!capability.registerPreview) return c.json(previewRefusal('headless'));
      try {
        const result = previewServeResultSchema.parse(await capability.registerPreview(c.req.valid('json'), capability.lifetime.signal));
        capability.lifetime.signal.throwIfAborted();
        return c.json(result);
      } catch {
        if (capability.lifetime.signal.aborted) return c.json({ code: 'capability_revoked' as const, message: ciErrorMessage('capability_revoked') }, 401);
        return c.json(previewRefusal('unavailable'));
      }
    })
    .use('/api/v1/tools/schedule-task', async (c, next) => {
      const capability = authorized(c.req.header('authorization'));
      if (!capability) return c.json(unauthorized, 401);
      c.set('capability', capability);
      await next();
    })
    // A prompt takes up to 100 000 characters, so these bodies get their own limit. The flag gate
    // runs before validation: off means off, whatever the body.
    .post('/api/v1/tools/schedule-task', bodyLimit({ maxSize: SCHEDULED_TASK_LIMITS.wireBytes, onError: c => c.json(scheduleRefusal('invalid_request', 'The arguments exceed 1 MiB.')) }), async (c, next) => {
      if (!automationsToolEnabled()) return c.json(scheduleRefusal('automations_off'));
      await next();
    }, jsonZodValidator(scheduleTaskRequestSchema, { invalid: (c, error) => c.json(scheduleRefusal('invalid_request', scheduleInvalidInput(error))) }), async c => {
      const capability = c.get('capability');
      if (!capability.scheduleTask) return c.json(scheduleRefusal('unavailable'));
      try {
        const answer = scheduleTaskAnswerSchema.parse(await capability.scheduleTask(c.req.valid('json'), capability.lifetime.signal));
        capability.lifetime.signal.throwIfAborted();
        return c.json(answer);
      } catch {
        if (capability.lifetime.signal.aborted) return c.json({ code: 'capability_revoked' as const, message: ciErrorMessage('capability_revoked') }, 401);
        return c.json(scheduleRefusal('unavailable'));
      }
    })
    .use('/api/v1/tools/scheduled-tasks', async (c, next) => {
      const capability = authorized(c.req.header('authorization'));
      if (!capability) return c.json(unauthorized, 401);
      c.set('capability', capability);
      await next();
    })
    .post('/api/v1/tools/scheduled-tasks', bodyLimit({ maxSize: SCHEDULED_TASK_LIMITS.wireBytes, onError: c => c.json(scheduleRefusal('invalid_request', 'The arguments exceed 1 MiB.')) }), async (c, next) => {
      if (!automationsToolEnabled()) return c.json(scheduleRefusal('automations_off'));
      await next();
    }, jsonZodValidator(scheduledTasksRequestSchema, { invalid: (c, error) => c.json(scheduleRefusal('invalid_request', scheduleInvalidInput(error))) }), async c => {
      const capability = c.get('capability');
      if (!capability.scheduledTasks) return c.json(scheduleRefusal('unavailable'));
      try {
        const answer = scheduledTasksAnswerSchema.parse(await capability.scheduledTasks(c.req.valid('json'), capability.lifetime.signal));
        capability.lifetime.signal.throwIfAborted();
        return c.json(answer);
      } catch {
        if (capability.lifetime.signal.aborted) return c.json({ code: 'capability_revoked' as const, message: ciErrorMessage('capability_revoked') }, 401);
        return c.json(scheduleRefusal('unavailable'));
      }
    });
}
export type CiToolApp = ReturnType<typeof ciToolRoutes>;
