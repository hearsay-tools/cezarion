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
import { ciWaitRequestSchema, ciWaitReceiptSchema, ciWaitErrorCodeSchema, type CiWait, type CiWaitRequest } from '@open-mercato/cezar-contract';
import { jsonZodValidator } from '../server/validators.ts';
import type { AgentRunSpec } from '../core/agent-runner.ts';

type Registration = (request: CiWaitRequest, signal: AbortSignal) => Promise<CiWait>;
type Capability = { register: Registration; lifetime: AbortController };
export type CiToolSession = { descriptor: NonNullable<AgentRunSpec['cezarTools']>; env: Record<string, string>; revoke(): void };
const unavailable = { code: 'unavailable' as const, message: 'CI tool unavailable: session authority expired or registration failed.' };

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

  provision(register: Registration): CiToolSession {
    if (this.closed) throw new Error(unavailable.message);
    const token = randomBytes(32).toString('hex');
    const capability = { register, lifetime: new AbortController() };
    this.capabilities.set(token, capability);
    const entry = fileURLToPath(new URL('./mcp.js', import.meta.url));
    // Source execution uses tsx already installed by the developer; installed artifacts use plain Node.
    const source = import.meta.url.endsWith('.ts');
    return {
      descriptor: { name: `cezar_ci_${randomUUID().replaceAll('-', '')}`, command: process.execPath, args: source ? ['--import', fileURLToPath(import.meta.resolve('tsx')), entry.replace(/\.js$/, '.ts')] : [entry] },
      env: { CEZ_TOOL_TOKEN: token, CEZ_TOOL_SOCKET: this.address },
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

/** Typed private route inventory: GET holds adapter lifetime; POST registers CI only. */
export function ciToolRoutes(capabilities: Map<string, Capability>) {
  return new Hono<{ Variables: { capability: Capability } }>()
    .use('/api/v1/tools/ci-wait', async (c, next) => {
      const authorization = c.req.header('authorization');
      const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
      const capability = token ? capabilities.get(token) : undefined;
      if (!capability || capability.lifetime.signal.aborted) return c.json({ ...unavailable, code: 'unauthorized' as const }, 401);
      c.set('capability', capability);
      await next();
      // The shared middleware uses the public API error envelope. Normalize this
      // private family to the CI contract without forwarding request contents.
      if (c.res.status === 400) c.res = c.json({ code: 'invalid_request' as const, message: 'Invalid CI wait arguments' }, 400);
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
    .post('/api/v1/tools/ci-wait', bodyLimit({ maxSize: 16_384, onError: c => c.json({ code: 'invalid_request' as const, message: 'CI request exceeds 16 KiB' }, 413) }), jsonZodValidator(ciWaitRequestSchema, { code: 'invalid_input', message: 'Invalid CI wait arguments' }), async c => {
      const capability = c.get('capability');
      try {
        const wait = await capability.register(c.req.valid('json'), capability.lifetime.signal);
        capability.lifetime.signal.throwIfAborted();
        const receipt = ciWaitReceiptSchema.parse({ waitId: wait.id, prUrl: wait.prUrl, repository: wait.repository, prNumber: wait.prNumber, headSha: wait.headSha, registeredAt: wait.registeredAt, deadline: wait.deadline, phase: wait.phase });
        return c.json(receipt);
      } catch (error) {
        const code = ciWaitErrorCodeSchema.safeParse(error && typeof error === 'object' && 'code' in error ? error.code : undefined);
        if (code.success) return c.json({ code: code.data, message: ciErrorMessage(code.data) }, 503);
        return c.json(unavailable, 503);
      }
    });
}
export type CiToolApp = ReturnType<typeof ciToolRoutes>;

function ciErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    wait_conflict: 'A different CI wait is already active for this run.',
    unsupported_host: 'GitHub Enterprise host is not recognized; use a host configured with the existing GitHub authentication.',
    gh_missing: 'Install GitHub CLI (gh) to wait for CI.',
    authentication: 'Authenticate GitHub CLI with gh auth login and retry.',
    inaccessible_pr: 'The pull request is inaccessible; check its URL and GitHub permissions.',
    capacity: 'CI wait registration capacity is exhausted; retry later.',
    persistence: 'CI wait could not be saved; check local storage and retry.',
    query_timeout: 'GitHub metadata lookup timed out; check connectivity and retry.',
    invalid_request: 'Invalid CI wait arguments.',
  };
  return messages[code] ?? unavailable.message;
}
