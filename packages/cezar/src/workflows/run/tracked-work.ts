import type { AgentSession } from '../../core/agent-runner.ts';

/** Observes owned work without changing its promise or failure policy. */
export class TrackedWork {
  private readonly operations = new Map<Promise<unknown>, string>();
  private readonly sessions = new Set<AgentSession>();
  private readonly listeners = new Set<() => void>();

  get pending(): ReadonlyMap<Promise<unknown>, string> { return this.operations; }
  get liveSessions(): ReadonlySet<AgentSession> { return this.sessions; }

  track<T>(label: string, promise: Promise<T>): Promise<T> {
    this.operations.set(promise, label);
    const release = () => {
      this.operations.delete(promise);
      for (const listener of this.listeners) listener();
    };
    void promise.then(release, release);
    return promise;
  }

  trackSession<T>(session: AgentSession, closed: Promise<T>): Promise<T> {
    this.sessions.add(session);
    const release = () => { this.sessions.delete(session); };
    void closed.then(release, release);
    return this.track('session', closed);
  }

  onSettle(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
