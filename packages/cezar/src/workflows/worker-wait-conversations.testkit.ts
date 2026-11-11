import { type RunnerId } from '../core/agent-runner.ts';
import { monitoringWakeOf } from './waits.testkit.ts';
import { delegatingParent, manager, spendWorkerBudget, store, until, worker } from './worker-wait-claude.testkit.ts';

type ConversationParent = Awaited<ReturnType<typeof delegatingParent>>;
type ConversationPair = ConversationParent & {
  w: Awaited<ReturnType<typeof worker>>;
  parentCaller: ReturnType<ConversationParent['callerFor']>;
  workerCaller: ReturnType<ConversationParent['callerFor']>;
};

export async function conversationPair(runner: RunnerId = 'claude'): Promise<ConversationPair> {
  const { p, service, callerFor, close } = await delegatingParent({ runner, permissions: ['spawn', 'wait', 'steer'] });
  await until(() => store.getRun(p.id)?.status === 'waiting');
  const w = await worker(p.id, 'mock:hold', runner);
  // An idle worker that only talks: it plain-parks rather than ask its parent (hearsay-tools/cezarion#1301).
  spendWorkerBudget(w.id);
  manager.enqueueOwnedRun(w.id);
  await until(() => store.getRun(w.id)?.status === 'waiting');
  return { p, w, service, parentCaller: callerFor(p.id), workerCaller: callerFor(w.id), callerFor, close };
}

// A parent with a live worker parks on a monitoring timer after handling a request
// (hearsay-tools/cezarion#1233). The parked state before delivery looks the same, and waiting
// for it raced the scheduler's Git probe, so the request's own turn must have ended.
export const turnEnds = (runId: string) => store.readEvents(runId).filter(event => event.type === 'turn-end').length;
export async function parentHandledRequest(parentId: string, inputId: string, boundaries: number) {
  await until(() => {
    const run = store.getRun(parentId);
    return run?.status === 'waiting' && !!monitoringWakeOf(run) && turnEnds(parentId) > boundaries &&
      !!run.agentInputs?.find(input => input.id === inputId)?.deliveredAt;
  });
}
