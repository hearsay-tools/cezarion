import type { RunManager } from '../workflows/run.ts';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { RunStore } from '../runs/store.ts';
import { CredentialRegistry } from './credentials.ts';
import { DelegationService, delegationEnabled, rootDelegation, type DelegationProject } from './service.ts';
import { createDelegationRoutes } from './routes.ts';
import { createDelegationApp, startDelegationTransport } from './transport.ts';
import { delegationEndpoint } from './cli.ts';

export type DelegationSession = { restrictNativeDelegation: true; env: Record<string, string>; instructions: string; revoke(): void };
export type DelegationProvisioner = (runId: string) => DelegationSession | undefined;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function bundledWorkerInvocation(command: 'worker' | 'discover' | 'message' = 'worker'): string {
  // Source-mode dev uses this checkout's loader; a published installation needs only Node.
  const source = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(new URL(source ? '../index.ts' : '../index.js', import.meta.url));
  return [process.execPath, ...(source ? ['--import', import.meta.resolve('tsx')] : []), entry].map(quote).join(' ') + ` ${command}`;
}

export function provisionDelegationSession(options: { projectId: string; runId: string; store: RunStore; credentials: CredentialRegistry; url: string }): DelegationSession | undefined {
  if (!delegationEnabled()) return;
  delegationEndpoint(options.url);
  const run = options.store.getRun(options.runId);
  if (!run || run.delegation?.role === 'invalid') return;
  const invocation = bundledWorkerInvocation();
  const messaging = bundledWorkerInvocation('message');
  const conversationGuidance = [
    `Use ${messaging} for task conversations. Root tasks can message peer root tasks in the same project and their owned workers; workers may address only their parent. Use ${messaging} tasks [--all] [--offset <n>] to discover peers (32 per page); workers cannot list peers. Peer review/terminal tasks need their human to continue them; messages never resume a peer.`,
    `Use ${messaging} request <recipient-run-id> '<text>' --id <message-UUID> to request an explicit reply; use ${messaging} progress <recipient-run-id> '<text>' --id <message-UUID> for an update without an obligation.`,
    `Use ${messaging} follow-up <recipient-run-id> '<text>' --id <message-UUID> --request-id <request-UUID> to clarify your request, or ${messaging} reply <recipient-run-id> '<text>' --id <message-UUID> --request-id <request-UUID> to answer an incoming request.`,
    `A request's ID is its message ID. Reuse a message ID only for an exact retry, including timeout; changed payloads are rejected.`,
    `Messages reach the recipient's live session as soon as they are accepted, including mid-turn; they are read at its next model step. ${messaging} inbox remains a fallback read during an active turn; it acknowledges only the messages it returns. Use ${messaging} conversation <recipient-run-id> [--before <cursor>] for history or investigation; it does not acknowledge messages.`,
    `Use ${messaging} conversation <recipient-run-id> [--before <cursor>] to inspect messages/outcomes, ${messaging} cancel-request <request-UUID> to cancel your obligation, and ${messaging} wait --request <request-UUID> [--request <another-UUID>] --mode <one|any|all> --timeout-seconds <1-1800> (or cezar_wait with kind "request") to register a request wait.`,
    `A root task that waits for a peer to write uses ${messaging} wait --peer <task-id> [--peer <another-task-id>] --timeout-seconds <1-1800> (or cezar_wait with kind "peer"): a message from a named peer, or that peer settling, resolves it; workers cannot register it.`,
    `Request and wait deadlines default to 600 seconds. Several waits can be open at once (workers, peers, CI, timers); messages wake you and close no wait, except a named peer's message to a peer wait; ${messaging} cancel-wait <wait-id> stops one wait without cancelling requests or work.`,
    `Wait returns immediately: end your turn to release capacity; Messages wake you and close no wait; end the turn again to keep waiting. A message does not resolve a pending request: only its reply does.`,
    `Acceptance, provider delivery, explicit reply, and task completion are distinct. Only reply resolves a request as replied; a reply after deadline expiry amends timed-out to replied-late without reopening the obligation; other settled outcomes stay unchanged.`,
    `Parents can resume their settled done/review/failed worker by sending a new instruction with ${invocation} resume <worker-id> '<instruction>' --id <new-message-UUID> --timeout-seconds <1-86400>. A resume request stays pending until reply, lifecycle settlement or its deadline (default 600 seconds, maximum 86400 seconds / 24 hours); set e.g. --timeout-seconds 7200 for a two-hour review round. Extended deadlines require actually resuming a settled worker; active workers still accept at most 1800 seconds. A worker wait has its own deadline and never extends the request. Exact retries never create another continuation.`,
    `Ordinary requests to review/terminal recipients return not-delivered with a reason and next command, and exit 1. Changing a rejected send requires a new message ID. Workers cannot resume parents; stopped/destroyed workers need a new worker. Messages never answer a human's question; a parent's reply answers only its worker's routed question.`,
    `Pending conversations are submitted together within a 100,000-character batch limit. Each keeps its own ID and request outcome; receipts report queued, delivered and consumed separately. A wait refusal explains why; successful registration parks only when you end your turn.`,
    `At most 100,000 characters per message, 32 undelivered inputs per recipient, 1,024 family messages, and 32 pending requests. Peer messages count toward the ledger and recipient input caps. A peer message that starts a new turn charges the automatic-wake budget (40 turns); when spent, messages stay queued until the human resets it. Steering inside a running turn and family messages do not charge.`,
    `Controller persistence prevents duplicate queue entries; a crash between provider acceptance and its delivery checkpoint can still make delivery ambiguous.`,
    `Credentials stay in the environment: never read, echo, forward, or persist them.`,
  ].join(' ');

  // No metadata on ordinary off/unavailable paths. Root authority is durable before a token exists.
  if (!run.delegation) options.store.commitDelegation([{ id: run.id, delegation: rootDelegation() }]);
  const generation = randomUUID();
  const token = options.credentials.issue(options.projectId, run.id, generation);
  options.store.registerSessionSecret(token);
  return {
    restrictNativeDelegation: true,
    env: { CEZ_DELEGATION_URL: options.url, CEZ_DELEGATION_TOKEN: token },
    instructions: run.delegation?.role === 'worker'
      ? [
        `You are an owned cezar worker. Your parent run ID is ${run.delegation.parentRunId}.`,
        conversationGuidance,
        `You cannot delegate, control peers, merge automatically, or accept your own review.`,
        `Follow your assigned task and selected input context. Your questions — cezar_ask, or a native question — go to your parent, which answers or asks the human; do not wait for a human.`,
        `Native workers are not tracked by cezar: do not spawn them.`,
        `Per-run controls suppress verified native entry points only; custom extensions, Claude forked skills (context: fork) and same-user unrestricted shell are not hard isolation.`,
        `Commit reviewed work before your parent deliberately integrates it; report the summary, commits, tests and remaining concerns.`,
        `When you park before finishing while your parent waits on you, Cezar tells your parent what you wait on and quotes your last message: end such a turn by saying what you wait on and what you have done.`,
      ].join(' ')
      : [
        `Prefer governed cezar workers for delegation.`,
        `Native workers are not tracked by cezar; do not spawn them.`,
        `Per-run controls suppress verified native entry points only; custom extensions, Claude forked skills (context: fork) and same-user unrestricted shell are not hard isolation.`,
        `Owned workers are available through the bundled command ${invocation}.`,
        `Commands return JSON.`,
        `Before choosing a runner or model, use ${bundledWorkerInvocation('discover')} runners, then ${bundledWorkerInvocation('discover')} models --runner=<name>.`,
        `Discovery lists host default-account runner status, enablement, model IDs and advertised per-model effortLevels; absent effort metadata means unknown. It uses your controller automatically.`,
        `A fresh nonempty default-account catalog rejects unknown explicit default-account model pins before creating a worker and reports available models and alternative runners; unavailable, empty or stale discovery does not invent choices. Inherited defaults and accepted retries stay unchanged.`,
        conversationGuidance,
        `Worker questions arrive as requests carrying a question; answer with ${messaging} reply <worker-id> '<answer>' --id <new-message-UUID> --request-id <question-id>, one '<header>: <answer>' line per question (an option's label, or your own words for a question without options), which the worker reads verbatim as its answer. If you cannot decide, ask the human with your own question, then reply. Progress and follow-ups never answer it, and you cannot finish while it is unanswered.`,
        `Use ${invocation} spawn --baseline parent-head --request-id <UUID> '<task>' (or an explicit committed ref).`,
        `Reuse the request ID only for the exact same task/baseline/context/runner/model/effort/workflow/skill on a retry.`,
        `Optional spawn flags: --workflow <name> or --skill <name> (mutually exclusive), --context '<selected text>' or --context-file <local-UTF-8-file> (mutually exclusive), --attach <path> (repeatable; copies a git-ignored file from your worktree into the worker's worktree at the same relative path before it starts; tracked or unignored files and .gitignore are refused, commit those instead), --runner <claude|codex|opencode|pi|cursor|omp>, --model <model>, --effort <low|medium|high|xhigh|max>.`,
        `--workflow runs a catalog workflow (the built-in quick-task or a .ai/cezar/workflows/*.yaml name) inside the worker, agent and check steps alike; --skill runs one discovered skill as the worker task; omitting both means quick-task; a worker inherits your extra system prompt, never your selected skill.`,
        `--runner, --model and --effort fill only the steps that leave those fields unset; an unknown name fails. Agent steps may mix runners: each step is pinned to its own runner, account, model, effort and grants at spawn, and a step's agentProfile names its account explicitly.`,
        `Example: spawn --baseline parent-head --request-id <UUID> --runner codex --context 'Inspect only the parser' 'Review parser'.`,
        `Example: spawn --baseline parent-head --request-id <UUID> --workflow review 'Review the parser change'.`,
        `Task plus context text is limited to 100,000 characters.`,
        `The API also accepts up to 32 baseline-file, parent-attachment or parent-file references, with at most 8 MiB of copied attachments.`,
        `Inspect reports worker-local input paths.`,
        `Omitted --runner inherits the active parent's runner; same-runner workers inherit omitted model/account/effort, while mixed-runner workers use that runner's project/default account and model.`,
        `Accepted identity and grants remain fixed.`,
        `Use list to find every worker you own, including incomplete cleanup with remaining resources. Use inspect <worker-id>, collect <worker-id>, steer <worker-id> '<text>', stop <worker-id>, destroy <worker-id>, diff <worker-id>, or wait <worker-id>... --mode <one|any|all> --timeout-seconds <1-1800>.`,
        `Mode defaults to any; one requires one worker, all requires every selected worker to settle.`,
        `cancel-wait <wait-id> stops one wait, is safe to retry, and never touches workers.`,
        `Wait registers and returns immediately: end your turn to release capacity, then Cezar resumes you on a selected terminal outcome or deadline (default 600 seconds).`,
        `Your other waits stay open beside it; timeout/cancellation reports partial outcomes and unresolved workers. The same wait is open to you as cezar_wait with kind "worker".`,
        `When a worker you wait on parks before finishing, Cezar sends you a notice from it naming what it waits on, at most one per wait; like any message it wakes you and closes no wait.`,
        `collect returns revision/status/settled plus typed summary/head/diff/artifacts availability and records the latest evidence under the parent.`,
        `An available diff.path points to a JSON result file: read its diffSnapshot field for the bounded patch, not the file as a raw patch.`,
        `Running output is partial.`,
        `Collect the latest settled revision of every worker before completing; Continue invalidates older readiness.`,
        `A done while workers are live or uncollected is refused once with what to do first; done again while workers are live makes Cezar wait on them for you and wake you when they have all settled, never silently finishing.`,
        `If a parent is already under review, Continue the parent first, then the worker.`,
        `Review changes and deliberately integrate desired worker commits with Git before cleanup; no automatic merge or review acceptance.`,
        `Collect/integrate desired results, destroy owned resources, explicitly delete child histories through the cockpit/API, then delete parent history.`,
        `Summary and bounded diff snapshots survive until parent deletion; general artifact bytes are not archived.`,
        `Branch/path strings and SHAs are historical descriptors after removal.`,
        `At most 32 outstanding workers (accepted, live, or not yet verifiably destroyed) and 1,024 creations per parent; destroy finished workers to free capacity. These limits bound resources and runaway spawning, not spending; 32 undelivered steering messages per worker.`,
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
  private transport?: Awaited<ReturnType<typeof startDelegationTransport>> | undefined;
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
  attachProject(project: DelegationProject & { manager: Pick<RunManager, 'setDelegationProvisioner'> }): () => void {
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
      // By project, not by run: a credential outlives nothing the store has to list (#779).
      this.credentials.revokeProject(project.id);
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
