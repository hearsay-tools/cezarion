import { WAIT_LIMIT, waitSchema, waitRegistrationReceiptSchema, type Wait, type WaitRegistrationReceipt } from '@open-mercato/cezar-contract/waits';
import { agentInputSchema, type AgentInput } from '@open-mercato/cezar-contract/delegation';
import type { RunRecord } from './store.ts';

function matchingReceipt(run: RunRecord, registration: WaitRegistrationReceipt, waitId: string): boolean {
  const prior = run.waitRegistrations?.find(row => row.operationId === registration.operationId);
  if (!prior) return false;
  if (prior.requestHash !== registration.requestHash || prior.wait.id !== waitId) throw Object.assign(new Error('conflicting registration operation'), { code: 'operation_conflict' });
  return true;
}
export function registeredWaitRecord(run: RunRecord, wait: Wait, input?: AgentInput, registration?: WaitRegistrationReceipt): RunRecord {
  if (registration && matchingReceipt(run, registration, wait.id)) return run;
  const entry = waitSchema.parse(wait);
  if (entry.phase !== 'open' && entry.phase !== 'resolved') throw new Error('a settled wait is committed through its delivery or cancellation');
  const waits = run.waits ?? [];
  const known = waits.some(row => row.id === entry.id);
  if (!known && entry.phase === 'open' && waits.filter(row => row.phase === 'open').length >= WAIT_LIMIT) throw new Error(`open wait limit reached (${WAIT_LIMIT})`);
  const agentInput = input ? agentInputSchema.parse(input) : undefined;
  const receiptRun = registration ? registeredReceiptRecord(run, registration) : run;
  return { ...receiptRun, waits: known ? waits.map(row => row.id === entry.id ? entry : row) : [...waits, entry], lastWaitsError: undefined,
    ...(agentInput ? { agentInputs: run.agentInputs?.some(row => row.id === agentInput.id) ? run.agentInputs : [...run.agentInputs ?? [], agentInput] } : {}) };
}
export function registeredReceiptRecord(run: RunRecord, receipt: WaitRegistrationReceipt): RunRecord {
  const parsed = waitRegistrationReceiptSchema.parse(receipt);
  if (matchingReceipt(run, parsed, parsed.wait.id)) return run;
  return { ...run, waitRegistrations: [...run.waitRegistrations ?? [], parsed] };
}
