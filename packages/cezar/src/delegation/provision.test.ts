import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture } from './service.testkit.ts';
import { provisionDelegationSession, DelegationController } from './provision.ts';
import { buildChildEnv } from '../core/agent-env.ts';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import * as transport from './transport.ts';

describe('session provisioning', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const provision = (id = f.parent.id) => provisionDelegationSession({ projectId: 'project', runId: id, store: f.store, credentials: f.credentials, url: 'http://127.0.0.1:12345/api/v1/delegation' });
  it('rotates session identity, revokes on teardown, and never includes a token in instructions/events', () => {
    expect(provision()!.instructions).toContain('--runner <claude|codex|opencode|pi|cursor|omp>');
    const first = provision()!; const old = f.credentials.authenticate(first.env.CEZ_DELEGATION_TOKEN!)!;
    expect(first.instructions).toContain('worker spawn'); expect(first.instructions).toContain('--effort'); expect(first.instructions).toContain('wait --request'); expect(first.instructions).not.toContain(first.env.CEZ_DELEGATION_TOKEN!);
    const second = provision()!;
    expect(f.credentials.authenticate(first.env.CEZ_DELEGATION_TOKEN!)).toBeUndefined();
    expect(f.credentials.authenticate(second.env.CEZ_DELEGATION_TOKEN!)).toMatchObject({ runId: f.parent.id });
    // Finishing the previous wrapper must not revoke the newer session.
    first.revoke(); expect(f.credentials.authenticate(second.env.CEZ_DELEGATION_TOKEN!)).toBeDefined();
    f.store.appendEvent(f.parent.id, { type: 'text', text: `echo ${second.env.CEZ_DELEGATION_TOKEN}` });
    expect(JSON.stringify(f.store.readEvents(f.parent.id))).not.toContain(second.env.CEZ_DELEGATION_TOKEN!);
    vi.stubEnv('CEZ_REDACT_SECRETS', '0');
    f.store.appendEvent(f.parent.id, { type: 'text', text: `echo ${second.env.CEZ_DELEGATION_TOKEN}` });
    expect(JSON.stringify(f.store.readEvents(f.parent.id))).not.toContain(second.env.CEZ_DELEGATION_TOKEN!);
    second.revoke(); expect(f.credentials.authenticate(second.env.CEZ_DELEGATION_TOKEN!)).toBeUndefined();
    expect(old.runId).toBe(f.parent.id);
  });
  it.each(RUNNER_IDS)('passes only session-specific env to %s even with full parent env', backend => {
    const session = provision()!;
    expect(session.instructions).toContain('inbox remains a fallback read during an active turn; it acknowledges only the messages it returns');
    // #505: messages reach a live session mid-turn; nothing promises turn-boundary delivery.
    expect(session.instructions).toContain('Messages reach the recipient\'s live session as soon as they are accepted, including mid-turn');
    expect(session.instructions).not.toContain('next safe turn boundary');
    expect(session.instructions).toContain('receipts report queued, delivered and consumed separately');
    expect(session.instructions).toContain('conversation <recipient-run-id> [--before <cursor>] for history or investigation; it does not acknowledge messages');
    const env = buildChildEnv({ backend, source: { CEZ_AGENT_ENV_FULL: '1', CEZ_DELEGATION_TOKEN: 'parent-token', CEZ_DELEGATION_URL: 'http://evil' }, extraEnv: session.env });
    expect(env.CEZ_DELEGATION_TOKEN).toBe(session.env.CEZ_DELEGATION_TOKEN); expect(env.CEZ_DELEGATION_URL).toBe('http://127.0.0.1:12345/api/v1/delegation');
  });
  // hearsay-tools/cezarion#632: parents learn one spelling. `--backend` stays a CLI alias, but the
  // instructions every delegating session receives must never teach it again.
  it('teaches --runner and never --backend in the parent instructions', () => {
    const { instructions } = provision()!;
    expect(instructions).toContain(`--runner <${RUNNER_IDS.join('|')}>`);
    expect(instructions).toContain('--request-id <UUID> --runner codex');
    expect(instructions).not.toMatch(/backend/i);
  });
  // hearsay-tools/cezarion#1149: a parent that never reads --help still learns --attach and its ignored-only rule.
  it('teaches --attach and the parent-file reference in the parent instructions', () => {
    const { instructions } = provision()!;
    expect(instructions).toMatch(/--attach <path> \(repeatable; copies a git-ignored file from your worktree[^)]*commit those instead\)/);
    expect(instructions).toContain('baseline-file, parent-attachment or parent-file references');
  });
  // hearsay-tools/cezarion#2440: listing --effort alone leaves the choice to inherited defaults.
  it('teaches deliberate effort selection, supported levels and inheritance in the parent instructions', () => {
    const { instructions } = provision()!;
    expect(instructions).toMatch(/Before choosing a runner, model or effort, use .* discover runners, then .* discover models --runner=<name>\./);
    expect(instructions).toContain('When overrides are allowed and effortLevels is nonempty, choose an explicit --effort level for the task from that list.');
    expect(instructions).toContain('Do not leave effort on auto by habit.');
    expect(instructions).toContain('An empty effortLevels list advertises no levels; absent metadata means support is unknown.');
    expect(instructions).toContain('Do not guess supported levels or override locked native settings.');
    expect(instructions).toContain('--effort <low|medium|high|xhigh|max|auto>');
    expect(instructions).toContain('Omitting --effort or using --effort auto applies the same rules: same-runner workers inherit the parent\'s effort; workers on another runner leave effort to that runner.');
    expect(instructions).toContain('--runner, --model and --effort fill only the steps that leave those fields unset');
    expect(instructions).toContain('--runner codex --effort high --context');
    expect(instructions).toContain('Use high here only when the selected model advertises it and overrides are allowed.');
  });
  it('teaches per-step settings when workflow models have no shared effort level', () => {
    const { instructions } = provision()!;
    expect(instructions).toContain('A spawn --effort pin applies to every agent step whose effort is unset.');
    expect(instructions).toContain('Use a shared effort only when every affected step\'s model advertises that level; otherwise use a workflow with compatible per-step effort settings.');
    expect(instructions).toContain('A high-only model and a low-only model need separate step settings.');
    expect(instructions).toContain('Omission and auto do not clear an inherited effort pin.');
  });
  it('provision text no longer says one active wait', () => {
    const { instructions } = provision()!;
    expect(instructions).not.toMatch(/one active wait|no automatic re-wait/i);
    expect(instructions).toContain('Several waits can be open at once (workers, peers, CI, timers)');
    expect(instructions).toContain('Messages wake you and close no wait');
    expect(instructions).toContain('cancel-wait <wait-id> stops one wait');
  });
  // hearsay-tools/cezarion#1995: the peer wait and the request kind are taught where the request wait is.
  it('teaches the peer wait and cezar_wait kinds request and peer', () => {
    const { instructions } = provision()!;
    expect(instructions).toMatch(/wait --peer <task-id> \[--peer <another-task-id>\] --timeout-seconds <1-1800> \(or cezar_wait with kind "peer"\)/);
    expect(instructions).toContain('(or cezar_wait with kind "request") to register a request wait');
    expect(instructions).toContain("except a named peer's message to a peer wait");
  });
  it('provisions no ordinary-run metadata while off and never promotes invalid/worker records to roots', async () => {
    const ordinary = f.store.createRun({ title: 'ordinary', task: 'ordinary', workflow: 'quick-task', steps: [] });
    vi.stubEnv('CEZ_DELEGATION', '0'); expect(provision(ordinary.id)).toBeUndefined(); expect(f.store.getRun(ordinary.id)?.delegation).toBeUndefined();
    vi.stubEnv('CEZ_DELEGATION', '1'); f.store.updateRun(ordinary.id, { delegation: { role: 'invalid' } });
    expect(provision(ordinary.id)).toBeUndefined();
    const { workerId } = await f.service.spawn(f.caller, { task: 'worker', baseline: 'HEAD', requestId: randomUUID() });
    const worker = provision(workerId)!; expect(worker.instructions).toContain('You cannot spawn Cezar workers'); expect(worker.instructions).toContain('wait --request'); expect(worker.instructions).toContain(f.parent.id); expect(worker.instructions).toContain('message reply');
    // #505: a worker's questions go to its parent, which replies or asks the human.
    expect(worker.instructions).toContain('Ask your parent with cez message request; any question you raise goes to your parent too, never to a human.');
    expect(worker.instructions).not.toContain('cezar_ask');
    expect(worker.instructions).not.toContain('only a human can answer');
    expect(worker.instructions).not.toContain('Messages never answer human questions');
    // hearsay-tools/cezarion#1327: a park notice quotes the worker's last message to its waiting parent.
    expect(worker.instructions).toContain('Cezar tells your parent what you wait on and quotes your last message');
    expect(worker.instructions).not.toContain('Cezar sends you a notice');
    const root = provision()!;
    expect(root.instructions).toContain('Cezar sends you a notice from it naming what it waits on, at most one per wait; like any message it wakes you and closes no wait');
    expect(root.instructions).not.toContain('Cezar tells your parent');
    expect(root.instructions).toContain('Worker questions arrive as requests carrying a question');
    expect(root.instructions).toContain('--request-id <question-id>');
    // hearsay-tools/cezarion#1234: an open question takes the parent's own words.
    expect(root.instructions).toContain("one '<header>: <answer>' line per question (an option's label, or your own words for a question without options)");
    expect(f.store.getRun(workerId)?.delegation).toMatchObject({ role: 'worker', permissions: [] });
    await expect(f.service.spawn(f.credentials.authenticate(worker.env.CEZ_DELEGATION_TOKEN!)!, { task: 'no', baseline: 'HEAD', requestId: randomUUID() })).rejects.toMatchObject({ code: 'denied_scope' });
  });
  // hearsay-tools/cezarion#2279: both roles may use native subagents; each mechanism has its own
  // purpose, and `cez message` is the only channel to another Cezar task.
  it('gives native subagents and Cezar workers distinct purposes, for roots and workers', async () => {
    const { workerId } = await f.service.spawn(f.caller, { task: 'worker', baseline: 'HEAD', requestId: randomUUID() });
    const worker = provision(workerId)!.instructions;
    const root = provision()!.instructions;
    expect(root).toContain('Use native subagents for work that needs no separate worktree: research, code reading and focused analysis.');
    expect(root).toContain('For example, a subagent reads the parser and summarizes how it handles errors.');
    expect(root).toContain('Use Cezar workers for work that needs its own worktree, its own commits or a lifecycle Cezar tracks.');
    expect(root).toContain('Also use a Cezar worker when the task needs a model available only through another runner, even if the work is research or analysis.');
    expect(root).toContain('Native subagents need no Cezar worker, worktree, collection or destruction.');
    expect(worker).toContain('You may use native subagents for research, code reading and focused analysis.');
    expect(worker).toContain('You cannot spawn Cezar workers.');
    expect(worker).not.toContain('Also use a Cezar worker');
    for (const text of [root, worker]) {
      expect(text).toContain('You may message your own native subagents with your runner\'s tools.');
      expect(text).toMatch(/Reach another Cezar task only through .* message; never use your runner's native tools for that\./);
      for (const old of ['Prefer governed cezar workers', 'Native workers are not tracked', 'do not spawn them', 'Per-run controls suppress', 'cannot delegate']) {
        expect(text).not.toContain(old);
      }
    }
  });
  it('starts no listener off; one failed listener leaves ordinary execution unprovisioned and logs once without secrets', async () => {
    const listen = vi.spyOn(transport, 'startDelegationTransport'); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('CEZ_DELEGATION', '0'); const off = await DelegationController.start(); expect(listen).not.toHaveBeenCalled(); await off.close();
    vi.stubEnv('CEZ_DELEGATION', '1'); listen.mockRejectedValue(Error('unavailable'));
    const broken = await DelegationController.start();
    broken.attachProject({ id: 'project', root: f.root, store: f.store, manager: f.manager });
    expect(broken.url).toBeUndefined(); expect(warn).toHaveBeenCalledTimes(1); await broken.close();
  });
});
