import { advancePendingHumanAsk } from '@open-mercato/cezar-contract/ask';
import type { RunHistoryEvent } from '@open-mercato/cezar-contract/events';
import { permissionRequestedSchema } from '@open-mercato/cezar-contract/permissions';

import { AgentItemsContextTracker } from './event-history-agent-context.ts';

interface ContextTracker {
  observe(event: RunHistoryEvent): void;
  events(): Iterable<RunHistoryEvent>;
}

class SnapshotContextTracker implements ContextTracker {
  private latest: RunHistoryEvent | undefined;

  constructor(private readonly matches: (event: RunHistoryEvent) => boolean) {}

  observe(event: RunHistoryEvent): void {
    if (this.matches(event)) this.latest = event;
  }

  events(): RunHistoryEvent[] {
    return this.latest ? [this.latest] : [];
  }
}

class AskContextTracker implements ContextTracker {
  pending: RunHistoryEvent | undefined;

  observe(event: RunHistoryEvent): void {
    // Agent/lifecycle input and refused human attempts do not answer a question.
    this.pending = advancePendingHumanAsk(this.pending, event);
  }

  events(): RunHistoryEvent[] {
    return this.pending ? [this.pending] : [];
  }
}

class AskRoutingContextTracker implements ContextTracker {
  /** The pending ask's latest routing transition (hearsay-tools/cezarion#505). */
  private routing: RunHistoryEvent | undefined;

  constructor(private readonly ask: AskContextTracker) {}

  observe(event: RunHistoryEvent): void {
    if ((event.type === 'worker-question-routed' || event.type === 'worker-question-fallback') && event.askSeq === this.ask.pending?.seq) {
      this.routing = event;
    }
  }

  events(): RunHistoryEvent[] {
    return this.ask.pending && this.routing?.askSeq === this.ask.pending.seq ? [this.routing] : [];
  }
}

/** A resolution or a session or turn boundary ends a pending permission request. */
class PermissionContextTracker implements ContextTracker {
  private readonly pending = new Map<string, RunHistoryEvent>();

  observe(event: RunHistoryEvent): void {
    if (event.type === 'permission.requested') {
      const { seq: _seq, ts: _ts, stepId: _stepId, ...payload } = event;
      if (permissionRequestedSchema.safeParse(payload).success) this.pending.set(event.requestId as string, event);
    } else if (event.type === 'permission.resolved' && typeof event.requestId === 'string') {
      this.pending.delete(event.requestId);
    } else if (event.type === 'session.ended' || event.type === 'session.started' || event.type === 'turn.completed') {
      this.pending.clear();
    }
  }

  events(): Iterable<RunHistoryEvent> {
    return this.pending.values();
  }
}

export class BoundaryContextTracker implements ContextTracker {
  turn = 0;
  private readonly retained: RunHistoryEvent[] = [];

  observe(event: RunHistoryEvent): void {
    if (event.type === 'user-message' || event.type === 'turn.started') {
      this.turn += 1;
      this.retained.push(event);
    } else if (event.type === 'turn.completed' || event.type === 'session.ended' || event.type === 'session.error') {
      this.retained.push(event);
    }
  }

  pruneBefore(earliest: number): void {
    const firstRetained = this.retained.findIndex(({ seq }) => seq >= earliest);
    if (firstRetained === -1) this.retained.length = 0;
    else if (firstRetained > 0) this.retained.splice(0, firstRetained);
  }

  events(): RunHistoryEvent[] {
    return this.retained;
  }
}

/** Preserve observation and merge order, including pruning before boundaries are collected. */
export function createContextTrackers(): ContextTracker {
  const ask = new AskContextTracker();
  const permissions = new PermissionContextTracker();
  const routing = new AskRoutingContextTracker(ask);
  const browser = new SnapshotContextTracker(event => event.type === 'preview.agent-browser');
  const plan = new SnapshotContextTracker(event => event.type === 'plan.updated' || (event.type === 'tool-call' && event.tool === 'TodoWrite'));
  const boundaries = new BoundaryContextTracker();
  const agents = new AgentItemsContextTracker(boundaries);
  const observers = [ask, permissions, routing, browser, plan, boundaries, agents];
  const collectors = [plan, browser, ask, permissions, routing, boundaries, agents];

  return {
    observe(event) {
      for (const tracker of observers) tracker.observe(event);
    },
    events() {
      agents.pruneSettledHistory();
      return collectors.flatMap(tracker => [...tracker.events()]);
    },
  };
}
