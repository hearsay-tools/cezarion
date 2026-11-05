/**
 * Which projects someone watches in the activity view (spec 2026-11-05-live-activity-view, CI
 * check progress). A project has demand for `HTTP_DEMAND_MS` after each HTTP snapshot read of
 * it, so a view that re-reads every 5 s keeps it, and demand ends after the last reader leaves.
 * The activity topic adds its subscribers later; the CI progress registry reads `has`.
 */
export const HTTP_DEMAND_MS = 15_000;

export class ActivityDemand {
  private readonly readUntil = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** An HTTP snapshot read of the project. */
  markRead(projectId: string): void {
    this.readUntil.set(projectId, this.now() + HTTP_DEMAND_MS);
  }

  has(projectId: string): boolean {
    const until = this.readUntil.get(projectId);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.readUntil.delete(projectId);
    return false;
  }
}
