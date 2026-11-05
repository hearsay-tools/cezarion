/**
 * Which projects someone watches in the activity view (spec 2026-11-05-live-activity-view, CI
 * check progress). A project has demand while an activity topic subscriber watches it or the whole
 * workspace, and for `HTTP_DEMAND_MS` after each HTTP snapshot read of it, so a view that re-reads
 * every 5 s keeps it, and demand ends after the last reader leaves. The CI progress registry reads
 * `has`.
 */
export const HTTP_DEMAND_MS = 15_000;

export class ActivityDemand {
  private readonly readUntil = new Map<string, number>();
  /** Topic watchers per project id; the key `undefined` is the whole workspace. */
  private readonly watchers = new Map<string | undefined, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** An HTTP snapshot read of the project. */
  markRead(projectId: string): void {
    this.readUntil.set(projectId, this.now() + HTTP_DEMAND_MS);
  }

  /** A topic publisher watches the project, or every project when `projectId` is absent, until the
   *  returned release runs. Releasing twice releases once. */
  watch(projectId?: string): () => void {
    this.watchers.set(projectId, (this.watchers.get(projectId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.watchers.get(projectId) ?? 1) - 1;
      if (left > 0) this.watchers.set(projectId, left);
      else this.watchers.delete(projectId);
    };
  }

  has(projectId: string): boolean {
    if (this.watchers.has(projectId) || this.watchers.has(undefined)) return true;
    const until = this.readUntil.get(projectId);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.readUntil.delete(projectId);
    return false;
  }
}
