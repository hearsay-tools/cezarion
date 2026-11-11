import type { RunLine } from './run-line.ts';
import { vi } from 'vitest';
import { unused } from '../fixture-no-runner.testkit.ts';
import { boundaryOrderFixture } from './boundary-order.testkit.ts';
import { InputDelivery } from './input-delivery.ts';

export function boundaryInputFixture(): ReturnType<typeof boundaryOrderFixture> & { delivery: InputDelivery; inputHost: ConstructorParameters<typeof InputDelivery>[1] } {
  const f = boundaryOrderFixture(true);
  const call = <T>(label: string, value: T) => vi.fn(() => { f.log.push(label); return value; });
  type Host = ConstructorParameters<typeof InputDelivery>[1];
  const line = unused<RunLine>('input line', {
    isParked: () => false, isAdmitted: () => false, hasWake: () => false,
    unpark: call('unpark', undefined), retireAdmission: call('retire-admission', true), admissions: () => new Set(),
  });
  const host = unused<Host>('input host', {
    active: f.active, line, workerExecutionStopped: () => false, executionBlockedByRootFinish: () => false,
    owesWake: call('owed', false), countAutomaticWakes: () => 0, canAutoContinue: () => true,
    hasUnansweredHumanAsk: () => false, pendingConversationWakes: () => [],
    move: (id, exit) => { f.log.push('resume'); return f.store.move(id, exit); },
    unreadInputGraceMs: () => 0, reconcileWorkerWaits: call('reconcile', undefined),
    workerExecutions: unused<Host['workerExecutions']>('worker executions', { trackDelivery: call('track', undefined) }),
    workerQuestions: unused<Host['workerQuestions']>('questions', { supersedeWorkerFallback: call('supersede', false), answeredElsewhere: () => false, pendingAnswer: () => undefined, isWorkerFallbackAsk: () => false }),
    attachments: unused<Host['attachments']>('attachments', { persistPastedAttachments: () => [] }),
    runSkills: unused<Host['runSkills']>('skills', { enabledSkills: () => [] }),
    humanWaits: unused<Host['humanWaits']>('human waits', { holdsAgentWaits: () => true }),
    inputReceiptHost: unused<Host['inputReceiptHost']>('receipts', { reconcileWorkerWaits: call('receipt-reconcile', undefined), isCurrentState: () => true, flushAgentInputs: call('retry-flush', undefined) }),
    settleTurn: call('settle', true),
    boundaryTurn: (_id, _state, session, done) => ({ session, done, stepId: 'step', ask: null, nudgedLastTurn: false, humanGate: false, monitoring: false }),
  });
  const delivery = new InputDelivery(f.context, host, 40, 'routed refusal');
  vi.spyOn(delivery, 'flushAgentInputs').mockImplementation(() => { f.log.push('input-flush'); return false; });
  return { ...f, delivery, inputHost: host };
}
