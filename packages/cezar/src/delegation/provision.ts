import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { workerOperationSchema } from '@open-mercato/cezar-contract';
import type { RunStore } from '../runs/store.ts';
import { CredentialRegistry } from './credentials.ts';
import { DelegationService, delegationEnabled, type DelegationProject } from './service.ts';
import { createDelegationRoutes } from './routes.ts';
import { createDelegationApp, startDelegationTransport } from './transport.ts';
import { delegationEndpoint } from './cli.ts';

export type DelegationSession = { env: Record<string, string>; instructions: string; revoke(): void };
export type DelegationProvisioner = (runId: string) => DelegationSession | undefined;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function bundledWorkerInvocation(): string {
  // Source-mode dev uses this checkout's loader; a published installation needs only Node.
  const source = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(new URL(source ? '../index.ts' : '../index.js', import.meta.url));
  return [process.execPath, ...(source ? ['--import', import.meta.resolve('tsx')] : []), entry].map(quote).join(' ') + ' worker';
}

export function provisionDelegationSession(options: { projectId: string; runId: string; store: RunStore; credentials: CredentialRegistry; url: string }): DelegationSession | undefined {
  if (!delegationEnabled()) return;
  delegationEndpoint(options.url);
  const run = options.store.getRun(options.runId);
  if (!run || run.delegation?.role === 'invalid') return;
  const invocation = bundledWorkerInvocation();
  // No metadata on ordinary off/unavailable paths. Root authority is durable before a token exists.
  if (!run.delegation) options.store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: [...workerOperationSchema.options], receipts: [] } }]);
  const generation = randomUUID();
  const token = options.credentials.issue(options.projectId, run.id, generation);
  options.store.registerSessionSecret(token);
  return {
    env: { CEZ_DELEGATION_URL: options.url, CEZ_DELEGATION_TOKEN: token },
    instructions: run.delegation?.role === 'worker'
      ? 'You are an owned worker. You cannot delegate, control peers, merge automatically, or accept your own review. Follow your assigned task; only a human can answer a pending human question.'
      : `Owned workers are available through the bundled command ${invocation}. Commands return JSON. Use ${invocation} spawn --baseline parent-head --request-id <UUID> '<task>' (or an explicit committed ref). Reuse the request ID only for the exact same task/baseline on a retry. Use inspect <worker-id>, steer <worker-id> '<text>', stop <worker-id>, destroy <worker-id>, diff <worker-id>, or wait <worker-id>... --timeout-seconds <1-1800>. Wait registers and returns immediately: end your turn to release capacity, then Cezar resumes you on a selected terminal outcome or deadline (default 600 seconds). No automatic re-wait. At most 32 accepted workers, including destroyed workers; 32 undelivered steering messages per worker. Review is a human gate. Destruction may be incomplete; inspect remaining resources and retry explicitly. Credentials are supplied only in the environment: never read, echo, forward or include them in commands, messages, prompts, events or files. Workers cannot delegate or message peers. This is cooperative local supervision, not process isolation.`,
    revoke: () => options.credentials.revoke(run.id, generation),
  };
}

/** Owns one invisible loopback listener in this controller, for cockpit AND headless use. */
export class DelegationController {
  readonly service = new DelegationService();
  readonly credentials = new CredentialRegistry();
  private transport?: Awaited<ReturnType<typeof startDelegationTransport>>;
  private projects = new Map<string, { project: DelegationProject; detach(): void }>();
  private closed = false;
  private warned = false;
  get url(): string | undefined { return this.transport?.url; }
  static async start(): Promise<DelegationController> {
    const controller = new DelegationController();
    if (delegationEnabled()) {
      try { controller.transport = await startDelegationTransport(createDelegationApp(createDelegationRoutes(controller.service, controller.credentials))); }
      catch { controller.unavailable(); }
    }
    return controller;
  }
  private unavailable() {
    if (!this.warned) { this.warned = true; console.warn('Delegation unavailable; ordinary runs remain enabled.'); }
  }
  attachProject(project: DelegationProject): () => void {
    if (this.closed) return () => {};
    this.projects.get(project.id)?.detach();
    const unregister = this.service.registerProject(project);
    const clear = project.manager.setDelegationProvisioner(runId => {
      if (this.closed || !this.transport || !delegationEnabled()) return;
      try { return provisionDelegationSession({ projectId: project.id, runId, store: project.store, credentials: this.credentials, url: this.transport.url }); }
      catch { this.credentials.revoke(runId); this.unavailable(); return; }
    });
    const detach = () => {
      clear(); unregister();
      for (const run of project.store.listRuns()) this.credentials.revoke(run.id);
      if (this.projects.get(project.id)?.detach === detach) this.projects.delete(project.id);
    };
    this.projects.set(project.id, { project, detach });
    return detach;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const { detach } of [...this.projects.values()]) detach();
    this.credentials.close();
    const transport = this.transport; this.transport = undefined;
    await transport?.close();
  }
}
