import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  agentInputSchema, delegationCancelWaitResultSchema, delegationErrorResponseSchema, delegationStateSchema,
  delegationWaitResultSchema, inboxClaimSchema, parentFileRefusal, peerCancelWaitResultSchema, peerWaitRegisteredSchema,
  peerWaitRequestSchema, peerWaitViewSchema, relatedRunTitleSchema, runDelegationSummarySchema, runRelationshipsSchema,
  workerCancelWaitRequestSchema, workerCancelWaitResultSchema, workerCapacitySchema, workerCollectedResultSchema,
  workerCompletionWaitSchema, workerContextSchema, workerDestroyResultSchema, workerDestroyViewSchema, workerDiffSchema,
  workerInputRecipeSchema, workerInspectionSchema, workerListEntrySchema, workerListPageSchema, workerListQuerySchema,
  workerListResultSchema, workerParamsSchema, workerResultFileSchema, workerSpawnRequestSchema, workerSpawnResultSchema,
  workerSteerRequestSchema, workerSteerResultSchema, workerStopResultSchema, workerWaitRequestSchema, workerWaitResultSchema,
} from './delegation.ts';
import { RUN_STATUS, WAIT_PHASE, WAIT_VIA, WORKER_OUTCOME_STATUS } from './test-factories.testkit.ts';

describe('parent-file context reference', () => {
  const context = (...paths: string[]) => ({ artifacts: paths.map(path => ({ kind: 'parent-file' as const, path })) });

  it('accepts a worktree-relative path', () => {
    expect(workerContextSchema.parse(context('.ai/qa/1149/brief.md'))).toEqual(context('.ai/qa/1149/brief.md'));
  });

  it.each(['/abs', '../x', 'a/./b', 'a//b', '.git/config', 'sub/.GIT/x', ''])('refuses %j', path => {
    expect(workerContextSchema.safeParse(context(path)).success).toBe(false);
  });

  it('refuses a duplicated path, naming it', () => {
    const parsed = workerContextSchema.safeParse(context('a.md', 'b.md', 'a.md'));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map(issue => issue.message)).toContainEqual(expect.stringContaining('duplicate --attach path: a.md'));
  });

  it.each(['.gitignore', 'qa/.gitignore', 'qa/data/.GitIgnore'])('refuses an attached .gitignore %j, naming it', path => {
    const parsed = workerContextSchema.safeParse(context(path));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map(issue => issue.message)).toContainEqual(`--attach cannot attach a .gitignore: ${path}; ignore rules must come from the baseline`);
  });

  it.each(['qa/.gitignore.bak', 'qa/gitignore', '.gitignore-notes/x.md'])('accepts a near-miss name %j', path => {
    expect(workerContextSchema.safeParse(context(path)).success).toBe(true);
  });

  it('leaves baseline-file references as they were', () => {
    expect(workerContextSchema.safeParse({ artifacts: [{ kind: 'baseline-file', path: 'src/x.ts' }] }).success).toBe(true);
  });
});

describe('delegation refusal details', () => {
  it.each(['.gitignore', 'qa/.GITIGNORE', 'nested/path/.gitignore'])('names the refused parent file %s', path => {
    expect(parentFileRefusal(path)).toBe(`--attach cannot attach a .gitignore: ${path}; ignore rules must come from the baseline`);
  });

  it.each(['', 'README.md', '.gitignore/file.md', 'qa/.gitignore.bak'])('permits the parent file %j', path => {
    expect(parentFileRefusal(path)).toBeUndefined();
  });

  it.each(['a\\b', 'a:b', 'a\u0000b', 'a\u001fb', 'a\u007fb'])('refuses unsafe input path %j', path => {
    expect(workerContextSchema.safeParse({ artifacts: [{ kind: 'parent-file', path }] }).success).toBe(false);
  });

  it.each(['resolved', 'delivered'])('names the missing result on a %s peer wait', phase => {
    const result = peerWaitViewSchema.safeParse({ id: '11111111-1111-4111-8111-111111111111',
      peerIds: ['22222222-2222-4222-8222-222222222222'], deadline: '2026-10-30T12:00:00Z', phase });
    expect(result.error?.issues).toEqual([{ code: 'custom', message: `a ${phase} peer wait has a result`, path: ['result'] }]);
  });

  it('refuses an open peer result but permits a cancelled result', () => {
    const wait = { id: '11111111-1111-4111-8111-111111111111', peerIds: ['22222222-2222-4222-8222-222222222222'],
      deadline: '2026-10-30T12:00:00Z', result: { reason: 'timeout' } };
    expect(peerWaitViewSchema.safeParse({ ...wait, phase: WAIT_PHASE.open }).error?.issues)
      .toEqual([{ code: 'custom', message: 'an open peer wait has no result', path: ['result'] }]);
    expect(peerWaitViewSchema.safeParse({ ...wait, phase: WAIT_PHASE.cancelled }).success).toBe(true);
  });

  it('bounds the combined spawn text and distinguishes skill from workflow', () => {
    const request = { task: 't', baseline: 'main', requestId: '11111111-1111-4111-8111-111111111111' };
    expect(workerSpawnRequestSchema.safeParse({ ...request, context: { text: 'c'.repeat(99999) } }).success).toBe(true);
    expect(workerSpawnRequestSchema.safeParse({ ...request, context: { text: 'c'.repeat(100000) } }).success).toBe(false);
    expect(workerSpawnRequestSchema.safeParse({ ...request, skill: 'review', workflow: 'quick-task' }).success).toBe(false);
    expect(workerSpawnRequestSchema.safeParse({ ...request, skill: 'review' }).success).toBe(true);
    expect(workerSpawnRequestSchema.safeParse({ ...request, workflow: 'quick-task' }).success).toBe(true);
    expect(workerSteerRequestSchema.safeParse({ text: ' \n\t' }).success).toBe(false);
  });
});

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const U4 = '44444444-4444-4444-8444-444444444444';
const T = '2026-10-30T12:00:00Z';
const SHA40 = 'a'.repeat(40);
const SHA64 = 'b'.repeat(64);
const HASH = 'c'.repeat(64);

/** The schema takes the value and returns it unchanged: no field dropped, renamed or added. */
const accepts = (schema: z.ZodType, value: unknown) => expect(schema.parse(value)).toEqual(value);
const refuses = (schema: z.ZodType, value: unknown) => expect(schema.safeParse(value).success).toBe(false);
const issuesOf = (schema: z.ZodType, value: unknown) =>
  schema.safeParse(value).error?.issues.map(({ code, message, path }) => ({ code, message, path }));
/** Every listed value is accepted under `key`, and a value outside the list is refused. */
function acceptsEach(schema: z.ZodType, base: Record<string, unknown>, key: string, values: readonly unknown[]) {
  for (const value of values) accepts(schema, { ...base, [key]: value });
  refuses(schema, { ...base, [key]: 'not-a-listed-value' });
}

const workspace = { ownerRunId: U1, resourceId: U2, kind: 'owned-isolated', path: '/w', branch: 'cez/w', baselineSha: SHA40 };
const outcome = { workerId: U2, status: WORKER_OUTCOME_STATUS.done, observedAt: T, summary: 'ok', revision: 2 };
const workerWait = {
  id: U1, workerIds: [U2, U3], requestIds: [U3, U4], requestOutcomes: [{ requestId: U3, status: 'replied', observedAt: T }],
  deadline: T, mode: 'all', revisions: [{ workerId: U2, revision: 1 }], reason: 'outcome', phase: 'parked', outcomes: [outcome], wakeId: U4,
};
const input = { source: { kind: 'parent-attachment', id: 'brief.v1_x-y' }, path: '/inputs/brief', sha256: HASH, bytes: 5 };
const destroy = { requestedAt: T, phase: 'incomplete', remaining: ['process', 'branch'], error: 'busy' };
const receipt = (requestId: string, workerId: string) => ({ requestId, workerId, requestHash: HASH });
const resultRef = (workerId: string) => ({ workerId, revision: 1, snapshotId: U3, observedAt: T, lastExecutionOutcome: 'completed',
  previous: { revision: 0, observedAt: T, lastExecutionOutcome: 'running' } });
const peerView = { id: U1, peerIds: [U2], deadline: T, phase: WAIT_PHASE.resolved, result: { reason: 'message', peerRunId: U2, messageId: U3 } };

describe('delegation identifiers and hashes', () => {
  it('accepts both commit SHA lengths and refuses anything around them', () => {
    for (const sha of [SHA40, SHA64]) accepts(workerSpawnResultSchema, { workerId: U1, baselineSha: sha });
    for (const sha of [`g${SHA40}`, `${SHA40}g`, `g${SHA64}`, `${SHA64}g`, 'a'.repeat(41), SHA40.toUpperCase()]) {
      refuses(workerSpawnResultSchema, { workerId: U1, baselineSha: sha });
    }
  });

  it('accepts only a whole 64-digit lowercase request hash', () => {
    accepts(workerInputRecipeSchema, { inputs: [input] });
    for (const sha256 of [`g${HASH}`, `${HASH}g`, 'c'.repeat(63), HASH.toUpperCase()]) {
      refuses(workerInputRecipeSchema, { inputs: [{ ...input, sha256 }] });
    }
  });

  it('refuses unknown fields on parameter, spawn and cancel shapes', () => {
    accepts(workerParamsSchema, { workerId: U1 });
    refuses(workerParamsSchema, { workerId: U1, extra: true });
    refuses(workerSpawnResultSchema, { workerId: U1, baselineSha: SHA40, extra: true });
    accepts(workerCancelWaitRequestSchema, { waitId: U1 });
    refuses(workerCancelWaitRequestSchema, { waitId: 'x' });
  });
});

describe('worker context and inputs', () => {
  it.each(['ab', 'a.b', '_x', '-x', 'a'.repeat(255)])('accepts the parent attachment id %j', id => {
    accepts(workerContextSchema, { artifacts: [{ kind: 'parent-attachment', id }] });
  });

  it.each(['', 'a'.repeat(256), '.a', 'a b', 'a..b', 'a/b'])('refuses the parent attachment id %j', id => {
    refuses(workerContextSchema, { artifacts: [{ kind: 'parent-attachment', id }] });
  });

  it('reports a refused .gitignore and a duplicate path as custom issues on that artifact path', () => {
    expect(issuesOf(workerContextSchema, { artifacts: [{ kind: 'parent-file', path: 'qa/.gitignore' }] })).toEqual([
      { code: 'custom', message: parentFileRefusal('qa/.gitignore'), path: ['artifacts', 0, 'path'] },
    ]);
    expect(issuesOf(workerContextSchema, { artifacts: ['a.md', 'b.md', 'a.md'].map(path => ({ kind: 'parent-file', path })) })).toEqual([
      { code: 'custom', message: 'duplicate --attach path: a.md', path: ['artifacts', 2, 'path'] },
    ]);
  });

  it('checks duplicates among parent files only', () => {
    accepts(workerContextSchema, { text: 'c', artifacts: [{ kind: 'baseline-file', path: 'a.md' }, { kind: 'baseline-file', path: 'a.md' }] });
    accepts(workerContextSchema, { artifacts: [{ kind: 'parent-attachment', id: 'a' }, { kind: 'parent-attachment', id: 'b' }] });
    accepts(workerContextSchema, { artifacts: [{ kind: 'baseline-file', path: 'a.md' }, { kind: 'parent-file', path: 'a.md' }] });
  });

  it('keeps every input field and bounds the recorded size', () => {
    accepts(workerInputRecipeSchema, { text: 'context', inputs: [input, { ...input, source: { kind: 'baseline-file', path: 'src/x.ts' }, bytes: 0 }] });
    accepts(workerInputRecipeSchema, { inputs: [{ ...input, bytes: Number.MAX_SAFE_INTEGER }] });
    for (const bad of [{ bytes: -1 }, { bytes: 1.5 }, { path: '' }, { path: 'p'.repeat(8193) }]) {
      refuses(workerInputRecipeSchema, { inputs: [{ ...input, ...bad }] });
    }
    accepts(workerInputRecipeSchema, { inputs: [{ ...input, path: 'p'.repeat(8192) }] });
    refuses(workerInputRecipeSchema, { inputs: [{ ...input, extra: true }] });
    refuses(workerInputRecipeSchema, { inputs: Array.from({ length: 33 }, () => input) });
    refuses(workerInputRecipeSchema, { text: 't'.repeat(100_001), inputs: [] });
  });
});

describe('worker spawn, steer and wait requests', () => {
  const spawn = { task: 'do it', baseline: 'main', requestId: U1 };

  it('trims the model, workflow and skill names and keeps every field', () => {
    const request = { ...spawn, context: { text: 'c', artifacts: [{ kind: 'baseline-file', path: 'a.md' }] }, backend: 'codex', effort: 'high' };
    expect(workerSpawnRequestSchema.parse({ ...request, model: ' m1 ', workflow: ' quick-task ' }))
      .toEqual({ ...request, model: 'm1', workflow: 'quick-task' });
    expect(workerSpawnRequestSchema.parse({ ...spawn, skill: ' review ' })).toEqual({ ...spawn, skill: 'review' });
    for (const name of ['model', 'workflow', 'skill']) refuses(workerSpawnRequestSchema, { ...spawn, [name]: '  ' });
    accepts(workerSpawnRequestSchema, { ...spawn, model: 'm'.repeat(512) });
    refuses(workerSpawnRequestSchema, { ...spawn, model: 'm'.repeat(513) });
    refuses(workerSpawnRequestSchema, { ...spawn, task: '' });
  });

  it('accepts every backend', () => {
    acceptsEach(workerSpawnRequestSchema, spawn, 'backend', ['claude', 'codex', 'opencode', 'pi', 'cursor', 'omp']);
  });

  it('names each refused spawn combination', () => {
    expect(issuesOf(workerSpawnRequestSchema, { ...spawn, skill: 'review', workflow: 'quick-task' }))
      .toEqual([{ code: 'custom', message: '--skill and --workflow cannot be used together', path: [] }]);
    expect(issuesOf(workerSpawnRequestSchema, { ...spawn, task: 't'.repeat(60_000), context: { text: 'c'.repeat(40_001) } }))
      .toEqual([{ code: 'custom', message: 'Combined task and context exceed 100000 characters', path: [] }]);
  });

  it('accepts a nonblank steer text up to its limit', () => {
    accepts(workerSteerRequestSchema, { text: 'go on' });
    accepts(workerSteerRequestSchema, { text: 's'.repeat(100_000) });
    refuses(workerSteerRequestSchema, { text: 's'.repeat(100_001) });
    refuses(workerSteerRequestSchema, { text: 'go on', extra: true });
  });

  it('defaults and bounds the worker wait deadline and limits one mode to one worker', () => {
    expect(workerWaitRequestSchema.parse({ workerIds: [U1] })).toEqual({ workerIds: [U1], timeoutSeconds: 600 });
    for (const timeoutSeconds of [1, 900, 1800]) accepts(workerWaitRequestSchema, { workerIds: [U1, U2], timeoutSeconds, mode: 'all' });
    for (const timeoutSeconds of [0, 1801, 1.5]) refuses(workerWaitRequestSchema, { workerIds: [U1], timeoutSeconds });
    refuses(workerWaitRequestSchema, { workerIds: [U1, U1] });
    refuses(workerWaitRequestSchema, { workerIds: [U1], extra: true });
    expect(issuesOf(workerWaitRequestSchema, { workerIds: [U1, U2], mode: 'one' }))
      .toEqual([{ code: 'custom', message: 'one mode requires exactly one worker', path: [] }]);
    accepts(workerWaitRequestSchema, { workerIds: [U1], timeoutSeconds: 600, mode: 'one' });
  });

  it('defaults and bounds the peer wait deadline', () => {
    expect(peerWaitRequestSchema.parse({ peerIds: [U1] })).toEqual({ peerIds: [U1], timeoutSeconds: 600 });
    for (const timeoutSeconds of [1, 900, 1800]) accepts(peerWaitRequestSchema, { peerIds: [U1, U2], timeoutSeconds });
    for (const timeoutSeconds of [0, 1801]) refuses(peerWaitRequestSchema, { peerIds: [U1], timeoutSeconds });
    refuses(peerWaitRequestSchema, { peerIds: [U1], extra: true });
  });
});

describe('agent inputs and inbox claims', () => {
  const claim = { receiptId: U1, generation: U2, expiresAt: T, acknowledgedAt: T, memberIds: [U3, U4] };
  const agentInput = {
    conversation: { senderRunId: U1, recipientRunId: U2, kind: 'request', relationship: 'peer' }, id: U3, source: agentInputSchema.shape.source.enum.agent, parentRunId: U1,
    text: 'hi', createdAt: T, deliveredAt: T, consumedAt: T, awaitingRead: true, inboxClaim: claim, purpose: 'completion-refusal', requestHash: HASH, deadline: T,
  };

  it('keeps every claim field and refuses duplicate or empty members', () => {
    accepts(inboxClaimSchema, claim);
    refuses(inboxClaimSchema, { ...claim, memberIds: [U3, U3] });
    refuses(inboxClaimSchema, { ...claim, memberIds: [] });
    refuses(inboxClaimSchema, { ...claim, extra: true });
  });

  it('keeps every agent input field', () => {
    acceptsEach(agentInputSchema, agentInput, 'source', ['agent', 'lifecycle']);
    for (const bad of [{ text: '' }, { text: 't'.repeat(100_001) }, { awaitingRead: false }, { purpose: 'other' }, { extra: true }]) {
      refuses(agentInputSchema, { ...agentInput, ...bad });
    }
    accepts(agentInputSchema, { ...agentInput, text: 't'.repeat(100_000) });
    for (const requestHash of [`g${HASH}`, `${HASH}g`, 'c'.repeat(63)]) refuses(agentInputSchema, { ...agentInput, requestHash });
  });
});

describe('worker waits and their views', () => {
  it('keeps every worker wait field', () => {
    for (const instruction of ['go', 'i'.repeat(1000)]) accepts(workerWaitResultSchema, { wait: workerWait, instruction });
    refuses(workerWaitResultSchema, { wait: workerWait, instruction: '' });
    refuses(workerWaitResultSchema, { wait: workerWait, instruction: 'i'.repeat(1001) });
    acceptsEach(workerCancelWaitResultSchema, { wait: workerWait }, 'wait', [{ ...workerWait, reason: 'message' }, { ...workerWait, reason: 'cancelled' }]);
    refuses(workerCancelWaitResultSchema, { wait: { ...workerWait, workerIds: [U2, U2] } });
    refuses(workerCancelWaitResultSchema, { wait: { ...workerWait, requestIds: [] } });
  });

  it('shows a completion wait without a deadline or request fields', () => {
    const { deadline: _deadline, requestIds, requestOutcomes, ...view } = workerWait;
    const completion = { ...view, via: WAIT_VIA.completion };
    accepts(workerCompletionWaitSchema, completion);
    refuses(workerCompletionWaitSchema, { ...completion, deadline: T });
    refuses(workerCompletionWaitSchema, { ...completion, requestIds });
    refuses(workerCompletionWaitSchema, { ...completion, requestOutcomes });
  });

  it('answers a wait and a cancel with either a worker wait or a peer wait', () => {
    for (const result of [{ wait: workerWait, instruction: 'go' }, { wait: peerView, instruction: 'go' }]) accepts(delegationWaitResultSchema, result);
    for (const result of [{ wait: workerWait }, { wait: peerView }]) accepts(delegationCancelWaitResultSchema, result);
    accepts(peerWaitRegisteredSchema, { wait: peerView, instruction: 'i'.repeat(1000) });
    refuses(peerWaitRegisteredSchema, { wait: peerView, instruction: '' });
    refuses(peerWaitRegisteredSchema, { wait: peerView, instruction: 'i'.repeat(1001) });
    refuses(peerCancelWaitResultSchema, { wait: peerView, extra: true });
    accepts(peerCancelWaitResultSchema, { wait: { ...peerView, phase: WAIT_PHASE.open, result: undefined } });
  });
});

describe('delegation state', () => {
  const root = {
    role: 'root', conversation: { messages: [], outcomes: [] }, permissions: ['spawn', 'wait'],
    receipts: [receipt(U1, U2), { ...receipt(U3, U4), deletion: { phase: 'pending', revision: 1, resourceId: U1, generation: U2 } }],
    wait: workerWait, lastWait: workerWait, results: [resultRef(U2), resultRef(U3)], finishRequestedAt: T, historyDeletion: 'pending',
    completion: { phase: 'waiting', waitId: U1 },
  };
  const worker = {
    role: 'worker', wait: workerWait, lastWait: workerWait, permissions: [], parentRunId: U1, workspace, destroy,
    context: { text: 'c', inputs: [input] }, executionRevision: 1, executionStartSeq: 2,
  };

  it('keeps every root, worker and invalid field', () => {
    for (const state of [root, worker, { role: 'invalid' }]) accepts(delegationStateSchema, state);
    refuses(delegationStateSchema, { role: 'invalid', extra: true });
  });

  it('accepts every permission once and refuses a repeated one', () => {
    const all = ['spawn', 'inspect', 'steer', 'stop', 'destroy', 'diff', 'wait'];
    accepts(delegationStateSchema, { ...worker, permissions: all });
    for (const permission of all) accepts(delegationStateSchema, { ...worker, permissions: [permission] });
    refuses(delegationStateSchema, { ...worker, permissions: ['spawn', 'spawn'] });
    refuses(delegationStateSchema, { ...worker, permissions: ['spawn-all'] });
  });

  it('refuses a repeated receipt request, receipt worker or result worker', () => {
    refuses(delegationStateSchema, { ...root, receipts: [receipt(U1, U2), receipt(U1, U3)] });
    refuses(delegationStateSchema, { ...root, receipts: [receipt(U1, U2), receipt(U3, U2)] });
    refuses(delegationStateSchema, { ...root, results: [resultRef(U2), resultRef(U2)] });
    refuses(delegationStateSchema, { ...root, receipts: [{ ...receipt(U1, U2), requestHash: SHA40 }] });
  });

  it('accepts every receipt deletion and completion phase', () => {
    const deletion = { phase: 'complete', revision: 0, resourceId: U1, generation: U2 };
    for (const phase of ['pending', 'complete']) accepts(delegationStateSchema, { ...root, receipts: [{ ...receipt(U1, U2), deletion: { ...deletion, phase } }] });
    refuses(delegationStateSchema, { ...root, receipts: [{ ...receipt(U1, U2), deletion: { ...deletion, phase: 'done' } }] });
    acceptsEach(delegationStateSchema, root, 'completion', [{ phase: 'waiting' }, { phase: 'attention', waitId: U2 }]);
    refuses(delegationStateSchema, { ...root, historyDeletion: 'complete' });
  });

  it('accepts every destroy phase and remaining resource once', () => {
    for (const phase of ['requested', 'terminating', 'cleaning', 'complete', 'incomplete']) accepts(delegationStateSchema, { ...worker, destroy: { ...destroy, phase } });
    accepts(delegationStateSchema, { ...worker, destroy: { ...destroy, remaining: ['process', 'worktree', 'branch'] } });
    refuses(delegationStateSchema, { ...worker, destroy: { ...destroy, remaining: ['branch', 'branch'] } });
    refuses(delegationStateSchema, { ...worker, destroy: { ...destroy, error: 'e'.repeat(2001) } });
    accepts(delegationStateSchema, { ...worker, destroy: { ...destroy, error: 'e'.repeat(2000) } });
  });

  it('keeps every worker wait reason, phase and outcome status', () => {
    for (const reason of ['outcome', 'timeout', 'cancelled', 'message']) accepts(delegationStateSchema, { ...worker, wait: { ...workerWait, reason } });
    for (const phase of ['registered', 'parked', 'wake-pending']) accepts(delegationStateSchema, { ...worker, wait: { ...workerWait, phase } });
    for (const status of ['review', 'done', 'failed', 'cancelled']) {
      accepts(delegationStateSchema, { ...worker, wait: { ...workerWait, outcomes: [{ ...outcome, status }] } });
    }
    accepts(delegationStateSchema, { ...worker, wait: { ...workerWait, outcomes: [{ ...outcome, summary: 's'.repeat(4000) }] } });
    refuses(delegationStateSchema, { ...worker, wait: { ...workerWait, outcomes: [{ ...outcome, summary: 's'.repeat(4001) }] } });
  });

  it('summarizes a root wait by ids and a worker by its parent only', () => {
    const rootWait = { phase: 'parked', requestIds: [U3], workerIds: [U2], outcomes: [{ workerId: U2 }] };
    accepts(runDelegationSummarySchema, { role: 'root', wait: rootWait });
    accepts(runDelegationSummarySchema, { role: 'root', wait: { phase: 'registered' } });
    expect(runDelegationSummarySchema.parse({ ...root, wait: { ...workerWait, outcomes: [outcome] } }))
      .toEqual({ role: 'root', wait: { phase: 'parked', requestIds: [U3, U4], workerIds: [U2, U3], outcomes: [{ workerId: U2 }] } });
    expect(runDelegationSummarySchema.parse(worker)).toEqual({ role: 'worker', parentRunId: U1, wait: { phase: 'parked', requestIds: [U3, U4] } });
    accepts(runDelegationSummarySchema, { role: 'invalid' });
  });
});

describe('collected worker results', () => {
  const unavailable = { state: 'unavailable', reason: 'missing', detail: 'gone' };
  const deleted = { state: 'deleted', reason: 'missing' };
  const result = {
    workerId: U1, parentRunId: U2, revision: 3, observedAt: T, status: RUN_STATUS.done, outcome: 'completed', lastExecutionOutcome: 'completed',
    partial: false, settled: true, error: 'e', backend: 'pi', model: 'm1', baselineSha: SHA40, workspace: { ...workspace, state: 'available' },
    cleanup: 'retained', summary: { state: 'available', text: 'hi', source: 'assistant', seq: 4, truncated: false },
    head: { state: 'available', sha: SHA64 }, diff: { state: 'available', snapshotId: U3, path: '/r.json', truncated: true },
    artifacts: { state: 'available', truncated: false, items: [
      { state: 'available', id: 'a', path: '/a' }, { ...unavailable, id: 'b', path: '/b' }, { ...deleted, id: 'c', path: '/c' },
    ] },
  };

  it('keeps every result field in the result file', () => {
    accepts(workerResultFileSchema, { result, diffSnapshot: 'diff --git' });
    refuses(workerResultFileSchema, { result, diffSnapshot: 'd'.repeat(400_001) });
    accepts(workerResultFileSchema, { result, diffSnapshot: 'd'.repeat(400_000) });
  });

  it.each([
    ['status', ['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled']],
    ['outcome', ['running', 'review-ready', 'completed', 'failed', 'cancelled', 'destroyed']],
    ['lastExecutionOutcome', ['running', 'review-ready', 'completed', 'failed', 'cancelled']],
    ['cleanup', ['retained', 'requested', 'terminating', 'cleaning', 'complete', 'incomplete']],
    ['workspace', ['available', 'unavailable', 'deleted'].map(state => ({ ...workspace, state }))],
  ] as const)('accepts every %s value', (key, values) => {
    acceptsEach(workerCollectedResultSchema, result, key, values);
  });

  it('accepts every evidence state for the summary, head, diff and artifacts', () => {
    const missing = ['no-assistant-output', 'missing', 'unreadable', 'unverified'].map(reason => ({ ...unavailable, reason }));
    acceptsEach(workerCollectedResultSchema, result, 'summary', [...missing, deleted, { ...result.summary, text: 's'.repeat(4000) }]);
    acceptsEach(workerCollectedResultSchema, result, 'head', [{ state: 'available', sha: SHA40 }, { ...unavailable, sha: SHA40 }, { ...deleted, sha: SHA64 }, deleted]);
    acceptsEach(workerCollectedResultSchema, result, 'diff', [unavailable, deleted, { ...result.diff, path: 'p'.repeat(8192) }]);
    acceptsEach(workerCollectedResultSchema, result, 'artifacts', [unavailable, deleted, { ...result.artifacts, items: [] }]);
    for (const summary of [{ ...result.summary, text: '' }, { ...result.summary, text: 's'.repeat(4001) }, { ...result.summary, source: 'tool' }]) {
      refuses(workerCollectedResultSchema, { ...result, summary });
    }
    refuses(workerCollectedResultSchema, { ...result, diff: { ...result.diff, path: '' } });
    refuses(workerCollectedResultSchema, { ...result, summary: { ...deleted, reason: 'unreadable' } });
    refuses(workerCollectedResultSchema, { ...result, model: 'm'.repeat(513) });
    refuses(workerCollectedResultSchema, { ...result, artifacts: { ...result.artifacts, items: Array.from({ length: 33 }, () => result.artifacts.items[0]) } });
  });

  it('bounds the artifact ids and paths in every state', () => {
    for (const item of result.artifacts.items) {
      const items = (over: object) => ({ ...result, artifacts: { ...result.artifacts, items: [{ ...item, ...over }] } });
      accepts(workerCollectedResultSchema, items({ id: 'i'.repeat(255), path: 'p'.repeat(8192) }));
      refuses(workerCollectedResultSchema, items({ id: 'i'.repeat(256) }));
      refuses(workerCollectedResultSchema, items({ path: 'p'.repeat(8193) }));
    }
  });
});

describe('worker inspection, list and relationships', () => {
  const { deadline: _deadline, requestIds: _requestIds, requestOutcomes: _requestOutcomes, ...waitView } = workerWait;
  const inspection = {
    workerId: U1, parentRunId: U2, status: RUN_STATUS.running, currentStepId: 'implement', workspace, backend: 'claude', model: 'm1', inputs: [input],
    wait: workerWait, completionWait: { ...waitView, via: WAIT_VIA.completion }, destroy: { ...destroy, retry: { attempts: 1, nextAt: T, needsAttention: true } },
    outcome,
  };
  const entry = { workerId: U1, parentRunId: U2, status: RUN_STATUS.done, workspace, destroy, revision: 1, settled: true, destroyed: false };

  it('keeps every inspection field and accepts every status', () => {
    acceptsEach(workerInspectionSchema, inspection, 'status', ['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled']);
    refuses(workerInspectionSchema, { ...inspection, model: 'm'.repeat(513) });
    refuses(workerInspectionSchema, { ...inspection, inputs: Array.from({ length: 33 }, () => input) });
    accepts(workerDestroyViewSchema, inspection.destroy);
    refuses(workerDestroyViewSchema, { ...destroy, retry: { attempts: 0, nextAt: T } });
  });

  it('keeps every list entry field and refuses an inspection-only field', () => {
    accepts(workerListResultSchema, { workers: [entry, { ...entry, workerId: U3 }] });
    accepts(workerListEntrySchema, { ...entry, destroy: undefined });
    refuses(workerListEntrySchema, { ...entry, model: 'm1' });
    refuses(workerListResultSchema, { workers: [entry], extra: true });
  });

  it('bounds a list page and its next offset', () => {
    for (const nextOffset of [1, 32, 1024]) accepts(workerListPageSchema, { workers: [entry, entry], nextOffset });
    for (const nextOffset of [0, 1025, 1.5]) refuses(workerListPageSchema, { workers: [entry], nextOffset });
    refuses(workerListPageSchema, { workers: Array.from({ length: 33 }, () => entry) });
  });

  it.each(['0', '7', '12', '1024'])('accepts the list offset %j', offset => {
    accepts(workerListQuerySchema, { offset });
  });

  it.each(['1025', '9999', '12345', ' 1', '1 ', 'x1', '1x', '', '-1'])('refuses the list offset %j', offset => {
    refuses(workerListQuerySchema, { offset });
  });

  it('keeps the list query empty or with an offset only', () => {
    accepts(workerListQuerySchema, {});
    refuses(workerListQuerySchema, { offset: '1', limit: '2' });
  });

  it('keeps every relationships field', () => {
    const title = { id: 'r', title: 'Work', titleSummary: 'working', titleOrigin: 'auto' };
    const relationships = { parentRunId: U2, workers: [inspection], titles: [title, { id: 's', title: 'Other' }],
      capacity: { outstanding: 1, limit: 32, created: 2, creationLimit: 1024 } };
    accepts(runRelationshipsSchema, relationships);
    acceptsEach(relatedRunTitleSchema, title, 'titleOrigin', ['user', 'auto', 'marker']);
    refuses(workerCapacitySchema, { ...relationships.capacity, extra: 0 });
    refuses(workerCapacitySchema, { ...relationships.capacity, limit: -1 });
  });
});

describe('worker diff, stop, destroy and error answers', () => {
  it('keeps every diff field', () => {
    accepts(workerDiffSchema, { workerId: U1, baselineSha: SHA40, diff: 'diff --git', truncated: false });
    accepts(workerDiffSchema, { workerId: U1, baselineSha: SHA40, diff: 'd'.repeat(400_000), truncated: true });
    refuses(workerDiffSchema, { workerId: U1, baselineSha: SHA40, diff: 'd'.repeat(400_001), truncated: true });
  });

  it('accepts every stop state', () => {
    acceptsEach(workerStopResultSchema, { workerId: U1 }, 'state', ['stopping', 'terminated']);
  });

  it('keeps every destroy result field', () => {
    const deleted = [{ kind: 'worktree', path: '/w' }, { kind: 'branch', ref: 'cez/w' }];
    const result = { workerId: U1, state: 'complete', deleted, remaining: [], error: 'e' };
    acceptsEach(workerDestroyResultSchema, result, 'state', ['complete', 'incomplete']);
    acceptsEach(workerDestroyResultSchema, result, 'deleted', [[deleted[0]], [deleted[1]], [{ kind: 'worktree', path: 'p'.repeat(8192) }, { kind: 'branch', ref: 'r'.repeat(1024) }]]);
    for (const bad of [[...deleted, deleted[0]], [{ kind: 'worktree', path: 'p'.repeat(8193) }], [{ kind: 'branch', ref: 'r'.repeat(1025) }], [{ kind: 'branch', path: '/w' }]]) {
      refuses(workerDestroyResultSchema, { ...result, deleted: bad });
    }
  });

  it('keeps every steer answer state', () => {
    acceptsEach(workerSteerResultSchema, { workerId: U1 }, 'state', ['queued', 'delivered']);
    refuses(workerSteerResultSchema, { workerId: U1, state: 'queued', extra: true });
  });

  it('accepts every delegation error code', () => {
    const codes = ['unavailable_transport', 'unauthenticated', 'denied_scope', 'invalid_input', 'invalid_baseline',
      'incompatible_state', 'capacity_limit', 'unavailable_diff', 'incomplete_cleanup'];
    acceptsEach(delegationErrorResponseSchema, { error: 'refused' }, 'code', codes);
    refuses(delegationErrorResponseSchema, { code: 'invalid_input', error: 'e'.repeat(2001) });
  });
});
