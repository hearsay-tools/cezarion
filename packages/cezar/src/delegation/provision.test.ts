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
  afterEach(() => { f?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const provision = (id = f.parent.id) => provisionDelegationSession({ projectId: 'project', runId: id, store: f.store, credentials: f.credentials, url: 'http://127.0.0.1:12345/api/v1/delegation' });
  it('rotates session identity, revokes on teardown, and never includes a token in instructions/events', () => {
    const first = provision()!; const old = f.credentials.authenticate(first.env.CEZ_DELEGATION_TOKEN!)!;
    expect(first.instructions).toContain('worker spawn'); expect(first.instructions).not.toContain(first.env.CEZ_DELEGATION_TOKEN!);
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
    const env = buildChildEnv({ backend, source: { CEZ_AGENT_ENV_FULL: '1', CEZ_DELEGATION_TOKEN: 'parent-token', CEZ_DELEGATION_URL: 'http://evil' }, extraEnv: session.env });
    expect(env.CEZ_DELEGATION_TOKEN).toBe(session.env.CEZ_DELEGATION_TOKEN); expect(env.CEZ_DELEGATION_URL).toBe('http://127.0.0.1:12345/api/v1/delegation');
  });
  it('provisions no ordinary-run metadata while off and never promotes invalid/worker records to roots', async () => {
    const ordinary = f.store.createRun({ title: 'ordinary', task: 'ordinary', workflow: 'quick-task', steps: [] });
    vi.stubEnv('CEZ_DELEGATION', '0'); expect(provision(ordinary.id)).toBeUndefined(); expect(f.store.getRun(ordinary.id)?.delegation).toBeUndefined();
    vi.stubEnv('CEZ_DELEGATION', '1'); f.store.updateRun(ordinary.id, { delegation: { role: 'invalid' } });
    expect(provision(ordinary.id)).toBeUndefined();
    const { workerId } = await f.service.spawn(f.caller, { task: 'worker', baseline: 'HEAD', requestId: randomUUID() });
    const worker = provision(workerId)!; expect(worker.instructions).toContain('cannot delegate');
    expect(f.store.getRun(workerId)?.delegation).toMatchObject({ role: 'worker', permissions: [] });
    await expect(f.service.spawn(f.credentials.authenticate(worker.env.CEZ_DELEGATION_TOKEN!)!, { task: 'no', baseline: 'HEAD', requestId: randomUUID() })).rejects.toMatchObject({ code: 'denied_scope' });
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
