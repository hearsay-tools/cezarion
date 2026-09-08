import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { workerOperationSchema } from '@open-mercato/cezar-contract';
import type { RunStore } from '../runs/store.ts';
import { CredentialRegistry } from './credentials.ts';
import { DelegationService, delegationEnabled, type DelegationProject } from './service.ts';
import { createDelegationRoutes } from './routes.ts';
import { createDelegationApp, startDelegationTransport } from './transport.ts';
import { delegationEndpoint } from './cli.ts';

export type DelegationSession = { restrictNativeDelegation: true; env: Record<string, string>; instructions: string; revoke(): void };
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
    restrictNativeDelegation: true,
    env: { CEZ_DELEGATION_URL: options.url, CEZ_DELEGATION_TOKEN: token },
    instructions: run.delegation?.role === 'worker'
      ? [
        `You are an owned cezar worker.`,
        `You cannot delegate, control peers, merge automatically, or accept your own review.`,
        `Follow your assigned task and selected input context; only a human can answer a pending human question.`,
        `Native workers are not tracked by cezar: do not spawn them.`,
        `Per-run controls suppress verified native entry points only; custom extensions and same-user unrestricted shell are not hard isolation.`,
        `Commit reviewed work before your parent deliberately integrates it; report the summary, commits, tests and remaining concerns.`,
      ].join(' ')
      : [
        `Prefer governed cezar workers for delegation.`,
        `Native workers are not tracked by cezar; do not spawn them.`,
        `Per-run controls suppress verified native entry points only; custom extensions and same-user unrestricted shell are not hard isolation.`,
        `Owned workers are available through the bundled command ${invocation}.`,
        `Commands return JSON.`,
        `Use ${invocation} spawn --baseline parent-head --request-id <UUID> '<task>' (or an explicit committed ref).`,
        `Reuse the request ID only for the exact same task/baseline/context/backend/model on a retry.`,
        `Optional spawn flags: --context '<selected text>' or --context-file <local-UTF-8-file> (mutually exclusive), --backend <claude|codex|opencode|pi>, --model <model>.`,
        `Example: spawn --baseline parent-head --request-id <UUID> --backend codex --context 'Inspect only the parser' 'Review parser'.`,
        `Task plus context text is limited to 100,000 characters.`,
        `The API also accepts up to 32 baseline-file or parent-attachment references, with at most 8 MiB of copied attachments.`,
        `Inspect reports worker-local input paths.`,
        `Omitted backend inherits the active parent; same-backend workers inherit omitted model/account/effort, while mixed-backend workers use that backend's project/default account and model.`,
        `Accepted identity and grants remain fixed.`,
        `Use inspect <worker-id>, collect <worker-id>, steer <worker-id> '<text>', stop <worker-id>, destroy <worker-id>, diff <worker-id>, or wait <worker-id>... --mode <one|any|all> --timeout-seconds <1-1800>.`,
        `Mode defaults to any; one requires one worker, all requires every selected worker to settle.`,
        `cancel-wait <wait-id> cancels only waiting and is safe to retry, never workers.`,
        `Wait registers and returns immediately: end your turn to release capacity, then Cezar resumes you on a selected terminal outcome or deadline (default 600 seconds).`,
        `No automatic re-wait; timeout/cancellation reports partial outcomes and unresolved workers.`,
        `collect returns revision/status/settled plus typed summary/head/diff/artifacts availability and records the latest evidence under the parent.`,
        `An available diff.path points to a JSON result file: read its diffSnapshot field for the bounded patch, not the file as a raw patch.`,
        `Running output is partial.`,
        `Collect the latest settled revision of every worker before completing; Continue invalidates older readiness.`,
        `Automatic completion waits for workers then wakes you to inspect and collect, never silently finishes; a finite timeout needs explicit attention.`,
        `If a parent is already under review, Continue the parent first, then the worker.`,
        `Review changes and deliberately integrate desired worker commits with Git before cleanup; no automatic merge or review acceptance.`,
        `Collect/integrate desired results, destroy owned resources, explicitly delete child histories through the cockpit/API, then delete parent history.`,
        `Summary and bounded diff snapshots survive until parent deletion; general artifact bytes are not archived.`,
        `Branch/path strings and SHAs are historical descriptors after removal.`,
        `At most 32 accepted workers, including destroyed workers; 32 undelivered steering messages per worker.`,
        `Review is a human gate.`,
        `Destruction may be incomplete; inspect remaining resources and retry explicitly.`,
        `Credentials are supplied only in the environment: never read, echo, forward or include them in commands, messages, prompts, events or files.`,
        `Workers cannot delegate or message peers.`,
        `This is cooperative local supervision, not process isolation.`,
      ].join(' '),
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
