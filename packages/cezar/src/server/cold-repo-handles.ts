import { resolveRepoHandle } from './forge/github.ts';
import type { RepoHandle } from '../runs/store.ts';

const MAX_ACTIVE = 4;
const LOOKUP_TIMEOUT_MS = 5_000;
const RETRY_AFTER_MS = 60_000;

type Entry = {
  handle?: RepoHandle;
  retryAt: number;
  pending: boolean;
  controller?: AbortController;
};

/**
 * Demand-driven repository discovery for cold index rows (#97). Owned by one app, never by a
 * ProjectContext or RunStore: discovery cannot recover agents or write a stale runs.json.
 *
 * Reads return the last known handle synchronously. Each root has at most one queued/active
 * lookup, at most four lookups run at once, and each is aborted after five seconds. Failed
 * lookups retry only on a later read after a cooldown; no perpetual timer or network poll.
 * The route retains only registered cold roots, bounding memory/queued work by that registry.
 */
export class ColdRepoHandles {
  private readonly entries = new Map<string, Entry>();
  private readonly queue = new Map<string, Entry>();
  private active = 0;

  retainRoots(roots: ReadonlySet<string>): void {
    for (const [root, entry] of this.entries) {
      if (roots.has(root)) continue;
      this.entries.delete(root);
      this.queue.delete(root);
      entry.controller?.abort();
    }
  }

  get(root: string): RepoHandle | undefined {
    let entry = this.entries.get(root);
    if (!entry) {
      entry = { retryAt: 0, pending: false };
      this.entries.set(root, entry);
    }
    if (!entry.handle && !entry.pending && Date.now() >= entry.retryAt) {
      entry.pending = true;
      this.queue.set(root, entry);
      this.drain();
    }
    return entry.handle;
  }

  private drain(): void {
    while (this.active < MAX_ACTIVE) {
      const next = this.queue.entries().next().value;
      if (!next) return;
      const [root, entry] = next;
      this.queue.delete(root);
      this.active++;
      void this.discover(root, entry);
    }
  }

  private async discover(root: string, entry: Entry): Promise<void> {
    const controller = new AbortController();
    entry.controller = controller;
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    timer.unref();
    let onAbort = () => {};
    // Even a lookup that settles late cannot hold the queue or adopt a stale identity. The
    // resolver passes the signal to execFile too, so the underlying gh process is terminated.
    const aborted = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const handle = await Promise.race([resolveRepoHandle(root, controller.signal), aborted]);
      if (!controller.signal.aborted && this.entries.get(root) === entry && handle) {
        entry.handle = handle;
      }
    } catch {
      // Unknown identity leaves every reference untouched; a later request can retry.
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      entry.controller = undefined;
      entry.pending = false;
      entry.retryAt = Date.now() + RETRY_AFTER_MS;
      this.active--;
      this.drain();
    }
  }
}
