import { WAIT_KINDS } from './wait-kinds.ts';
import { randomUUID } from 'node:crypto';
import { squawkWaitRequestSchema, waitErrorCodeSchema, type SquawkWaitRequestInput, type Wait, type WaitRegistrationReceipt } from '@open-mercato/cezar-contract/waits';
import type { SquawkToolHandlers, WaitRegistration } from '../../ci-wait/controller.ts';
import { waitErrorMessage } from '../../ci-wait/errors.ts';
import { openWaitList, waitAnswerKind } from '../waits.ts';
import type { ToolHost } from './squawk-tools.ts';
import { registrationIdentity, replayRegistration } from './wait-registration.ts';

function accepted(host: ToolHost, runId: string, wait: Wait, receipt: WaitRegistrationReceipt | undefined, operationId: string, replayed: boolean): WaitRegistration {
  if (WAIT_KINDS[wait.kind].answerKind(wait) === undefined || !('deadline' in wait) || wait.deadline === undefined) throw new Error('invalid registration receipt');
  const run = host.store.getRun(runId);
  const current = [...run?.waits ?? [], ...run?.lastWaits ?? []].find(row => row.id === wait.id);
  return { answer: { ok: true, effect: replayed || receipt?.deduplicated ? 'unchanged' : 'applied', operation_id: operationId,
    deduplicated: receipt?.deduplicated ?? false, replayed, wait_phase: current?.phase ?? 'unavailable',
    wait_id: wait.id, kind: waitAnswerKind(wait), deadline: wait.deadline, open_waits: openWaitList(run?.waits ?? []) }, wait };
}
function refused(host: ToolHost, runId: string, request: SquawkWaitRequestInput, error: unknown): WaitRegistration {
  const fields = error && typeof error === 'object' ? error : {};
  const code = waitErrorCodeSchema.safeParse('code' in fields ? fields.code : undefined);
  if (!code.success) throw error;
  const retained = 'retainedWait' in fields ? openWaitList([fields.retainedWait as Wait])[0] : undefined;
  return { answer: { ok: false, effect: 'refused', operation_id: request.operation_id, code: code.data,
    message: waitErrorMessage(code.data), open_waits: openWaitList(host.store.getRun(runId)?.waits ?? []),
    ...(retained ? { retained_wait: retained } : {}) } };
}
// Serialize only overlapping retries of one operation. Different operations retain their
// existing registration concurrency; the durable receipt remains the source of truth.
const pendingOperations = new WeakMap<object, Map<string, Promise<WaitRegistration>>>();
function serializeOperation(store: object, key: string, action: () => Promise<WaitRegistration>): Promise<WaitRegistration> {
  let pending = pendingOperations.get(store);
  if (!pending) { pending = new Map(); pendingOperations.set(store, pending); }
  const prior = pending.get(key);
  const result = (prior ? prior.catch(() => undefined).then(action) : action());
  pending.set(key, result);
  void result.finally(() => { if (pending.get(key) === result) pending.delete(key); }).catch(() => undefined);
  return result;
}
export function registrationToolHandler(runId: string, generation: string, host: ToolHost): SquawkToolHandlers['registerWait'] {
  return async (request, via, signal) => {
    const identified = { ...request, operation_id: request.operation_id ?? randomUUID() };
    return serializeOperation(host.store, `${runId}\n${identified.operation_id}`, async () => {
    try {
      const identity = registrationIdentity(squawkWaitRequestSchema.parse(identified));
      const before = !!host.store.getRun(runId)?.waitRegistrations?.some(row => row.operationId === identified.operation_id);
      let wait;
      try { wait = await host.registerWait(runId, identified, via, generation, signal); }
      catch (error) {
        // A watcher/park error after commit cannot undo registration.
        wait = replayRegistration(host.store.getRun(runId), identity);
        if (!wait) throw error;
      }
      const receipt = host.store.getRun(runId)?.waitRegistrations?.find(row => row.operationId === identified.operation_id);
      return accepted(host, runId, wait, receipt, identified.operation_id, before);
    } catch (error) { return refused(host, runId, identified, error); }
    });
  };
}
